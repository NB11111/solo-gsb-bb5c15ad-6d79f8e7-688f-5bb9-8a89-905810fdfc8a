import type { DB } from './db';

/**
 * 比对级审阅分派：
 *  - 项目负责人为本轮比对登记审阅人名单（reviewers），并按片段批量分派；
 *  - 片段分派状态由 assignments 行推导：无行 = 未分派，status='assigned' = 已分派，
 *    status='completed' = 已完成；
 *  - 认领 / 完成 / 回收均携带版本号（version）做原子校验：
 *    认领要求 expected_version = 0（当前未分派），靠单事务内的存在性检查 +
 *    UNIQUE(fragment_id) 兜底，冲突时返回当前负责人而不覆盖；
 *    完成 / 回收用 UPDATE/DELETE ... WHERE id = ? AND version = ? AND status = 'assigned'，
 *    影响行数为 0 即冲突，返回当前分派状态；
 *  - 负责人只能回收「未完成」（assigned）的分派，回收后片段回到未分派，可再分派（转交）；
 *  - 已封存的比对禁止一切分派写操作（只读接口不受影响）。
 */

export type AssignmentStatus = 'assigned' | 'completed';

/** 片段分派状态（无分派行时为 unassigned） */
export type FragmentAssignState = 'unassigned' | AssignmentStatus;

export interface ReviewerRow {
  id: number;
  comparison_id: number;
  name: string;
  created_by: string | null;
  created_at: string;
}

export interface AssignmentRow {
  id: number;
  comparison_id: number;
  fragment_id: number;
  reviewer_id: number;
  status: AssignmentStatus;
  /** 乐观锁版本号：每次状态流转 +1，认领 / 完成 / 回收按版本号原子校验 */
  version: number;
  assigned_by: string;
  assigned_at: string;
  completed_by: string | null;
  completed_at: string | null;
}

export interface AssignmentView extends AssignmentRow {
  reviewer_name: string;
  fragment_ord: number;
}

export interface ReviewerProgress {
  reviewer: ReviewerRow;
  /** 进行中（已分派未完成） */
  assigned: number;
  /** 已完成 */
  completed: number;
  /** 分派总数（assigned + completed） */
  total: number;
}

export interface AssignmentSummary {
  /** 比对片段总数 */
  fragments: number;
  unassigned: number;
  assigned: number;
  completed: number;
}

export interface AssignmentBoard {
  comparison_id: number;
  sealed: boolean;
  reviewers: ReviewerProgress[];
  /** 全部片段分派（含片段序号与审阅人姓名），按片段序号排序 */
  assignments: AssignmentView[];
  summary: AssignmentSummary;
}

const ASSIGNMENT_VIEW_SQL = `
  SELECT a.*, r.name AS reviewer_name, f.ord AS fragment_ord
    FROM assignments a
    JOIN reviewers r ON r.id = a.reviewer_id
    JOIN fragments f ON f.id = a.fragment_id`;

function getComparisonSealState(
  db: DB,
  comparisonId: number
): { sealed: boolean } | null {
  const row = db
    .prepare('SELECT sealed_at FROM comparisons WHERE id = ?')
    .get(comparisonId) as { sealed_at: string | null } | undefined;
  if (!row) return null;
  return { sealed: row.sealed_at != null };
}

function getAssignmentByFragment(db: DB, fragmentId: number): AssignmentView | null {
  const row = db
    .prepare(`${ASSIGNMENT_VIEW_SQL} WHERE a.fragment_id = ?`)
    .get(fragmentId) as AssignmentView | undefined;
  return row ?? null;
}

function getAssignmentById(db: DB, assignmentId: number): AssignmentView | null {
  const row = db
    .prepare(`${ASSIGNMENT_VIEW_SQL} WHERE a.id = ?`)
    .get(assignmentId) as AssignmentView | undefined;
  return row ?? null;
}

/** 汇总某比对的审阅人名单、各片段分派与每人完成进度 */
export function getAssignmentBoard(db: DB, comparisonId: number): AssignmentBoard | null {
  const state = getComparisonSealState(db, comparisonId);
  if (!state) return null;

  const reviewers = db
    .prepare('SELECT * FROM reviewers WHERE comparison_id = ? ORDER BY id')
    .all(comparisonId) as ReviewerRow[];
  const assignments = db
    .prepare(`${ASSIGNMENT_VIEW_SQL} WHERE a.comparison_id = ? ORDER BY f.ord`)
    .all(comparisonId) as AssignmentView[];
  const fragmentCount = (
    db
      .prepare('SELECT COUNT(*) AS n FROM fragments WHERE comparison_id = ?')
      .get(comparisonId) as { n: number }
  ).n;

  const progress = new Map<number, ReviewerProgress>();
  for (const r of reviewers) {
    progress.set(r.id, { reviewer: r, assigned: 0, completed: 0, total: 0 });
  }
  const summary: AssignmentSummary = {
    fragments: fragmentCount,
    unassigned: fragmentCount,
    assigned: 0,
    completed: 0,
  };
  for (const a of assignments) {
    summary.unassigned--;
    summary[a.status]++;
    const p = progress.get(a.reviewer_id);
    if (p) {
      p[a.status]++;
      p.total++;
    }
  }

  return {
    comparison_id: comparisonId,
    sealed: state.sealed,
    reviewers: reviewers.map((r) => progress.get(r.id)!),
    assignments,
    summary,
  };
}

/** 按片段索引的分派映射（供比对详情嵌入每个片段） */
export function getAssignmentMap(db: DB, comparisonId: number): Map<number, AssignmentView> {
  const map = new Map<number, AssignmentView>();
  const rows = db
    .prepare(`${ASSIGNMENT_VIEW_SQL} WHERE a.comparison_id = ?`)
    .all(comparisonId) as AssignmentView[];
  for (const r of rows) map.set(r.fragment_id, r);
  return map;
}

/* ================= 审阅人名单 ================= */

export type RegisterReviewersResult =
  | { status: 'ok'; added: ReviewerRow[]; existing: string[] }
  | { status: 'not_found' }
  | { status: 'sealed' }
  | { status: 'invalid' };

/**
 * 批量登记审阅人名单。名单按比对隔离，同一比对内姓名唯一：
 * 请求内去重，已存在的姓名跳过并列入 existing，其余在单个事务内写入。
 */
export function registerReviewers(
  db: DB,
  comparisonId: number,
  names: string[],
  registeredBy: string | null
): RegisterReviewersResult {
  const tx = db.transaction((): RegisterReviewersResult => {
    const state = getComparisonSealState(db, comparisonId);
    if (!state) return { status: 'not_found' };
    if (state.sealed) return { status: 'sealed' };

    const unique: string[] = [];
    const seen = new Set<string>();
    for (const raw of names) {
      const name = String(raw ?? '').trim();
      if (!name) continue; // 批量登记时忽略空项（如末尾多余的逗号）
      if (name.length > 50) return { status: 'invalid' };
      if (!seen.has(name)) {
        seen.add(name);
        unique.push(name);
      }
    }
    if (unique.length === 0) return { status: 'invalid' };

    const findStmt = db.prepare(
      'SELECT * FROM reviewers WHERE comparison_id = ? AND name = ?'
    );
    const insertStmt = db.prepare(
      'INSERT INTO reviewers (comparison_id, name, created_by) VALUES (?, ?, ?)'
    );
    const added: ReviewerRow[] = [];
    const existing: string[] = [];
    for (const name of unique) {
      if (findStmt.get(comparisonId, name)) {
        existing.push(name);
        continue;
      }
      const info = insertStmt.run(comparisonId, name, registeredBy);
      added.push(
        db.prepare('SELECT * FROM reviewers WHERE id = ?').get(Number(info.lastInsertRowid)) as ReviewerRow
      );
    }
    return { status: 'ok', added, existing };
  });
  return tx();
}

export type RemoveReviewerResult =
  | { status: 'ok' }
  | { status: 'not_found' }
  | { status: 'sealed' }
  | { status: 'has_assignments' };

/** 从名单移除审阅人；仍存在分派（无论是否完成）时拒绝，避免丢失分派历史 */
export function removeReviewer(db: DB, reviewerId: number): RemoveReviewerResult {
  const tx = db.transaction((): RemoveReviewerResult => {
    const reviewer = db
      .prepare('SELECT * FROM reviewers WHERE id = ?')
      .get(reviewerId) as ReviewerRow | undefined;
    if (!reviewer) return { status: 'not_found' };
    const state = getComparisonSealState(db, reviewer.comparison_id);
    if (state?.sealed) return { status: 'sealed' };
    const used = db
      .prepare('SELECT COUNT(*) AS n FROM assignments WHERE reviewer_id = ?')
      .get(reviewerId) as { n: number };
    if (used.n > 0) return { status: 'has_assignments' };
    db.prepare('DELETE FROM reviewers WHERE id = ?').run(reviewerId);
    return { status: 'ok' };
  });
  return tx();
}

/* ================= 分派 / 认领 / 完成 / 回收 ================= */

export interface AssignmentConflict {
  fragment_id: number;
  fragment_ord: number;
  /** 冲突时的当前负责人（片段当前未分派时为 null） */
  current: AssignmentView | null;
}

export type AssignFragmentsResult =
  | {
      status: 'ok';
      assigned: AssignmentView[];
      /** 已存在分派的片段：不覆盖，返回当前负责人 */
      conflicts: AssignmentConflict[];
    }
  | { status: 'not_found' }
  | { status: 'sealed' }
  | { status: 'invalid'; message: string };

/**
 * 负责人按片段批量分派：
 *  - 片段必须属于本比对、审阅人必须在本比对名单内，否则整体 400 语义（invalid）；
 *  - 已存在分派的片段不覆盖：记入 conflicts 并附上当前负责人，其余片段照常写入；
 *  - 每条新分派 version = 1，整个批次在单个事务内完成。
 */
export function assignFragments(
  db: DB,
  comparisonId: number,
  items: Array<{ fragment_id: number; reviewer_id: number }>,
  assignedBy: string
): AssignFragmentsResult {
  const tx = db.transaction((): AssignFragmentsResult => {
    const state = getComparisonSealState(db, comparisonId);
    if (!state) return { status: 'not_found' };
    if (state.sealed) return { status: 'sealed' };
    if (!Array.isArray(items) || items.length === 0 || items.length > 500) {
      return { status: 'invalid', message: '分派列表不能为空且不超过 500 条' };
    }

    const fragStmt = db.prepare(
      'SELECT id FROM fragments WHERE id = ? AND comparison_id = ?'
    );
    const reviewerStmt = db.prepare(
      'SELECT id FROM reviewers WHERE id = ? AND comparison_id = ?'
    );
    for (const it of items) {
      if (!Number.isInteger(it?.fragment_id) || !Number.isInteger(it?.reviewer_id)) {
        return { status: 'invalid', message: '分派项的片段或审阅人不合法' };
      }
      if (!fragStmt.get(it.fragment_id, comparisonId)) {
        return { status: 'invalid', message: `片段 #${it.fragment_id} 不属于本比对` };
      }
      if (!reviewerStmt.get(it.reviewer_id, comparisonId)) {
        return { status: 'invalid', message: `审阅人 #${it.reviewer_id} 不在本比对名单内` };
      }
    }

    const insertStmt = db.prepare(
      `INSERT INTO assignments (comparison_id, fragment_id, reviewer_id, status, version, assigned_by)
       VALUES (?, ?, ?, 'assigned', 1, ?)`
    );
    const assigned: AssignmentView[] = [];
    const conflicts: AssignmentConflict[] = [];
    const done = new Set<number>();
    for (const it of items) {
      if (done.has(it.fragment_id)) continue; // 同一批次内重复片段只处理一次
      done.add(it.fragment_id);
      const existing = getAssignmentByFragment(db, it.fragment_id);
      if (existing) {
        conflicts.push({
          fragment_id: it.fragment_id,
          fragment_ord: existing.fragment_ord,
          current: existing,
        });
        continue;
      }
      const info = insertStmt.run(comparisonId, it.fragment_id, it.reviewer_id, assignedBy);
      assigned.push(getAssignmentById(db, Number(info.lastInsertRowid))!);
    }
    return { status: 'ok', assigned, conflicts };
  });
  return tx();
}

export type ClaimResult =
  | { status: 'ok'; assignment: AssignmentView }
  | { status: 'not_found' }
  | { status: 'sealed' }
  | { status: 'reviewer_mismatch' }
  | { status: 'version_mismatch'; current: AssignmentView | null }
  | { status: 'conflict'; current: AssignmentView };

/**
 * 审阅人认领未分派片段（乐观锁）：
 *  - expected_version 必须为 0（认领前片段处于「未分派」）；
 *  - 事务内先校验仍无分派再 INSERT，UNIQUE(fragment_id) 兜底并发认领；
 *  - 冲突（已被他人认领 / 负责人已分派）时返回当前负责人，绝不覆盖。
 */
export function claimFragment(
  db: DB,
  fragmentId: number,
  reviewerId: number,
  expectedVersion: number
): ClaimResult {
  const tx = db.transaction((): ClaimResult => {
    const frag = db
      .prepare(
        `SELECT f.id, f.comparison_id, c.sealed_at
           FROM fragments f JOIN comparisons c ON c.id = f.comparison_id
          WHERE f.id = ?`
      )
      .get(fragmentId) as
      | { id: number; comparison_id: number; sealed_at: string | null }
      | undefined;
    if (!frag) return { status: 'not_found' };
    if (frag.sealed_at != null) return { status: 'sealed' };

    const reviewer = db
      .prepare('SELECT id FROM reviewers WHERE id = ? AND comparison_id = ?')
      .get(reviewerId, frag.comparison_id) as { id: number } | undefined;
    if (!reviewer) return { status: 'reviewer_mismatch' };

    const existing = getAssignmentByFragment(db, fragmentId);
    if (existing) return { status: 'conflict', current: existing };
    if (expectedVersion !== 0) {
      // 客户端持有的版本号对应一条已不存在的分派（如刚被回收），按版本冲突处理
      return { status: 'version_mismatch', current: null };
    }

    try {
      const info = db
        .prepare(
          `INSERT INTO assignments (comparison_id, fragment_id, reviewer_id, status, version, assigned_by)
           VALUES (?, ?, ?, 'assigned', 1,
                   (SELECT name FROM reviewers WHERE id = ?))`
        )
        .run(frag.comparison_id, fragmentId, reviewerId, reviewerId);
      return { status: 'ok', assignment: getAssignmentById(db, Number(info.lastInsertRowid))! };
    } catch (err) {
      // 并发认领触发 UNIQUE(fragment_id)：返回当前负责人而不覆盖
      if (err instanceof Error && /UNIQUE/.test(err.message)) {
        const current = getAssignmentByFragment(db, fragmentId);
        if (current) return { status: 'conflict', current };
      }
      throw err;
    }
  });
  return tx();
}

export type CompleteResult =
  | { status: 'ok'; assignment: AssignmentView }
  | { status: 'not_found' }
  | { status: 'sealed' }
  | { status: 'conflict'; current: AssignmentView };

/**
 * 标记分派完成：版本号原子校验（WHERE id AND version AND status='assigned'），
 * 版本过期或已完成时影响行数为 0，返回当前分派状态而不覆盖。
 */
export function completeAssignment(
  db: DB,
  assignmentId: number,
  expectedVersion: number,
  completedBy: string | null
): CompleteResult {
  const tx = db.transaction((): CompleteResult => {
    const current = getAssignmentById(db, assignmentId);
    if (!current) return { status: 'not_found' };
    const state = getComparisonSealState(db, current.comparison_id);
    if (state?.sealed) return { status: 'sealed' };

    const info = db
      .prepare(
        `UPDATE assignments
            SET status = 'completed',
                completed_by = COALESCE(?, (SELECT name FROM reviewers WHERE id = reviewer_id)),
                completed_at = datetime('now', 'localtime'),
                version = version + 1
          WHERE id = ? AND version = ? AND status = 'assigned'`
      )
      .run(completedBy, assignmentId, expectedVersion);
    if (info.changes === 0) {
      return { status: 'conflict', current: getAssignmentById(db, assignmentId)! };
    }
    return { status: 'ok', assignment: getAssignmentById(db, assignmentId)! };
  });
  return tx();
}

export type ReclaimResult =
  | { status: 'ok'; fragment_id: number; fragment_ord: number }
  | { status: 'not_found' }
  | { status: 'sealed' }
  | { status: 'conflict'; current: AssignmentView };

/**
 * 负责人回收未完成分派：仅 status='assigned' 可回收，已完成的分派返回冲突；
 * 版本号原子校验，回收后片段回到「未分派」，可再次分派（转交）。
 */
export function reclaimAssignment(
  db: DB,
  assignmentId: number,
  expectedVersion: number
): ReclaimResult {
  const tx = db.transaction((): ReclaimResult => {
    const current = getAssignmentById(db, assignmentId);
    if (!current) return { status: 'not_found' };
    const state = getComparisonSealState(db, current.comparison_id);
    if (state?.sealed) return { status: 'sealed' };

    const info = db
      .prepare(
        `DELETE FROM assignments
          WHERE id = ? AND version = ? AND status = 'assigned'`
      )
      .run(assignmentId, expectedVersion);
    if (info.changes === 0) {
      return { status: 'conflict', current: getAssignmentById(db, assignmentId)! };
    }
    return { status: 'ok', fragment_id: current.fragment_id, fragment_ord: current.fragment_ord };
  });
  return tx();
}
