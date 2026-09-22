import express from 'express';
import path from 'node:path';
import { openDb } from './db';
import {
  createProject,
  importVersion,
  addAnnotation,
  getComparisonDetail,
  getProjectDetail,
  saveFragmentDecision,
  sealComparison,
  getSealBlockers,
  updateAnnotation,
  deleteAnnotation,
  getMigrationReport,
  getAnnotationCandidates,
  remountAnnotation,
  FRAGMENT_DECISIONS,
  type FragmentDecision,
} from './service';
import {
  getAssignmentBoard,
  registerReviewers,
  removeReviewer,
  assignFragments,
  claimFragment,
  completeAssignment,
  reclaimAssignment,
} from './assignment';
import { toCsv, toMarkdown } from './exporter';
import { buildResolution, resolutionToMarkdown } from './resolution';
import { seedDemo } from './demo';

const PORT = Number(process.env.PORT ?? 3000);
const DB_PATH = process.env.DB_PATH ?? path.join(process.cwd(), 'data', 'review.db');

const db = openDb(DB_PATH);
const app = express();

app.use(express.json({ limit: '20mb' }));

const VALID_STATUS = new Set(['open', 'resolved', 'pending_review']);

function badRequest(res: express.Response, message: string) {
  return res.status(400).json({ error: message });
}

function conflict(res: express.Response, message: string, extra?: Record<string, unknown>) {
  return res.status(409).json({ error: message, ...(extra ?? {}) });
}

function notFound(res: express.Response, message = '资源不存在') {
  return res.status(404).json({ error: message });
}

// ---------- 健康检查 ----------
app.get('/api/health', (_req, res) => {
  res.json({ ok: true, time: new Date().toISOString() });
});

// ---------- 项目 ----------
app.get('/api/projects', (_req, res) => {
  const projects = db
    .prepare(
      `SELECT p.*,
              (SELECT COUNT(*) FROM versions v WHERE v.project_id = p.id)    AS version_count,
              (SELECT COUNT(*) FROM comparisons c WHERE c.project_id = p.id) AS comparison_count
         FROM projects p
        ORDER BY p.id DESC`
    )
    .all();
  res.json({ projects });
});

app.post('/api/projects', (req, res) => {
  const name = String(req.body?.name ?? '').trim();
  if (!name) return badRequest(res, '项目名称必填');
  if (name.length > 100) return badRequest(res, '项目名称过长');
  const id = createProject(db, name);
  res.status(201).json({ id, name });
});

app.get('/api/projects/:id', (req, res) => {
  const detail = getProjectDetail(db, Number(req.params.id));
  if (!detail) return notFound(res, '项目不存在');
  res.json(detail);
});

app.delete('/api/projects/:id', (req, res) => {
  const info = db.prepare('DELETE FROM projects WHERE id = ?').run(Number(req.params.id));
  if (info.changes === 0) return notFound(res, '项目不存在');
  res.status(204).end();
});

// ---------- 版本导入（按所选基线比对 + 批注迁移） ----------
app.post('/api/projects/:id/versions', (req, res) => {
  const projectId = Number(req.params.id);

  const label = String(req.body?.label ?? '').trim();
  const content = String(req.body?.content ?? '');
  if (!label) return badRequest(res, '版本标签必填');
  if (!content.trim()) return badRequest(res, '版本内容必填');

  // 比对基线：省略时取项目最新版本；显式指定时必须为项目内早于新版本的历史版本
  let baselineVersionId: number | undefined;
  if (req.body?.baseline_version_id !== undefined && req.body?.baseline_version_id !== null) {
    baselineVersionId = Number(req.body.baseline_version_id);
    if (!Number.isInteger(baselineVersionId) || baselineVersionId <= 0) {
      return badRequest(res, '比对基线版本不合法');
    }
  }

  const result = importVersion(db, projectId, label, content, baselineVersionId);
  if (result.status === 'error') {
    if (result.reason === 'not_found') return notFound(res, '项目不存在');
    if (result.reason === 'baseline_not_in_project') {
      return badRequest(res, '比对基线必须为本项目的历史版本');
    }
    return badRequest(res, '比对基线必须早于本次导入的新版本');
  }
  res.status(201).json(result);
});

// ---------- 比对结果 ----------
app.get('/api/comparisons/:id', (req, res) => {
  const detail = getComparisonDetail(db, Number(req.params.id));
  if (!detail) return notFound(res, '比对不存在');
  res.json(detail);
});

/** 批注筛选：?status=open|resolved|pending_review & author=xxx */
app.get('/api/comparisons/:id/annotations', (req, res) => {
  const comparisonId = Number(req.params.id);
  const exists = db.prepare('SELECT id FROM comparisons WHERE id = ?').get(comparisonId);
  if (!exists) return notFound(res, '比对不存在');

  const conds = ['a.comparison_id = ?'];
  const params: unknown[] = [comparisonId];
  const { status, author } = req.query;
  if (typeof status === 'string' && status) {
    if (!VALID_STATUS.has(status)) return badRequest(res, '非法的批注状态');
    conds.push('a.status = ?');
    params.push(status);
  }
  if (typeof author === 'string' && author) {
    conds.push('a.author = ?');
    params.push(author);
  }
  const annotations = db
    .prepare(
      `SELECT a.*, f.ord AS fragment_ord, f.type AS fragment_type
         FROM annotations a
         LEFT JOIN fragments f ON f.id = a.fragment_id
        WHERE ${conds.join(' AND ')}
        ORDER BY a.id`
    )
    .all(...params);
  res.json({ annotations });
});

// ---------- 批注 ----------
app.post('/api/fragments/:id/annotations', (req, res) => {
  const author = String(req.body?.author ?? '').trim();
  const content = String(req.body?.content ?? '').trim();
  if (!author) return badRequest(res, '作者必填');
  if (!content) return badRequest(res, '批注内容必填');
  if (author.length > 50) return badRequest(res, '作者姓名过长（最多 50 字）');
  const result = addAnnotation(db, Number(req.params.id), author, content);
  if (result.status === 'not_found') return notFound(res, '片段不存在');
  if (result.status === 'sealed') return conflict(res, '该比对已封存，禁止新增批注');
  const annotation = db.prepare('SELECT * FROM annotations WHERE id = ?').get(result.id);
  res.status(201).json({ annotation });
});

// ---------- 片段审阅结论 ----------
app.patch('/api/fragments/:id/decision', (req, res) => {
  const fragmentId = Number(req.params.id);
  const rawDecision = String(req.body?.decision ?? '');
  if (!FRAGMENT_DECISIONS.includes(rawDecision as FragmentDecision)) {
    return badRequest(res, '结论必须为 accepted / rejected / deferred 之一');
  }
  const decision = rawDecision as FragmentDecision;
  let reason: string | null = null;
  if (req.body?.reason !== undefined && req.body?.reason !== null) {
    reason = String(req.body.reason).trim();
  }
  if (decision === 'deferred' && (reason == null || !reason)) {
    return badRequest(res, '暂缓时必须填写暂缓理由');
  }
  if (reason != null && reason.length > 1000) {
    return badRequest(res, '暂缓理由过长（最多 1000 字）');
  }
  let decidedBy: string | null = null;
  if (req.body?.decided_by !== undefined && req.body?.decided_by !== null) {
    decidedBy = String(req.body.decided_by).trim();
    if (decidedBy.length > 50) return badRequest(res, '结论提出人姓名过长（最多 50 字）');
  }

  const result = saveFragmentDecision(db, fragmentId, decision, reason, decidedBy);
  if (result.status === 'not_found') return notFound(res, '片段不存在');
  if (result.status === 'sealed') return conflict(res, '该比对已封存，禁止修改片段结论');
  if (result.status === 'reason_required') return badRequest(res, '暂缓时必须填写暂缓理由');

  const fragment = db
    .prepare('SELECT id, decision, decision_reason, decided_by, decided_at FROM fragments WHERE id = ?')
    .get(fragmentId);
  res.json({ fragment });
});

// ---------- 审阅封存 ----------
app.get('/api/comparisons/:id/seal/blockers', (req, res) => {
  const comparisonId = Number(req.params.id);
  const cmpRow = db.prepare('SELECT sealed_at FROM comparisons WHERE id = ?').get(comparisonId) as
    | { sealed_at: string | null }
    | undefined;
  if (!cmpRow) return notFound(res, '比对不存在');
  res.json({
    sealed: cmpRow.sealed_at != null,
    blockers: cmpRow.sealed_at != null ? [] : getSealBlockers(db, comparisonId),
  });
});

app.post('/api/comparisons/:id/seal', (req, res) => {
  const comparisonId = Number(req.params.id);
  const sealedBy = String(req.body?.sealed_by ?? '').trim();
  if (!sealedBy) return badRequest(res, '封存人必填');
  if (sealedBy.length > 50) return badRequest(res, '封存人姓名过长（最多 50 字）');

  const result = sealComparison(db, comparisonId, sealedBy);
  if (result.status === 'not_found') return notFound(res, '比对不存在');
  if (result.status === 'already_sealed') {
    return conflict(res, '该比对已封存，无法重复封存', { sealed: result.sealed });
  }
  if (result.status === 'blocked') {
    return conflict(res, '仍存在未完成的审阅项，无法封存', { blockers: result.blockers });
  }
  res.status(201).json({ sealed: result.sealed });
});

app.patch('/api/annotations/:id', (req, res) => {
  const id = Number(req.params.id);
  const ann = db.prepare('SELECT * FROM annotations WHERE id = ?').get(id) as
    | { id: number; status: string; content: string }
    | undefined;
  if (!ann) return notFound(res, '批注不存在');

  const { status, content } = req.body ?? {};
  if (status === undefined && content === undefined) {
    return badRequest(res, '至少提供 status 或 content 之一');
  }
  if (status !== undefined && !VALID_STATUS.has(status)) {
    return badRequest(res, '非法的批注状态（open / resolved / pending_review）');
  }
  let trimmedContent: string | null = null;
  if (content !== undefined) {
    trimmedContent = String(content).trim();
    if (!trimmedContent) return badRequest(res, '批注内容不能为空');
  }
  const result = updateAnnotation(
    db,
    id,
    status !== undefined ? String(status) : null,
    trimmedContent
  );
  if (result.status === 'not_found') return notFound(res, '批注不存在');
  if (result.status === 'sealed') {
    return conflict(res, '该比对已封存，禁止编辑批注或变更批注状态');
  }
  res.json({ annotation: db.prepare('SELECT * FROM annotations WHERE id = ?').get(id) });
});

app.delete('/api/annotations/:id', (req, res) => {
  const result = deleteAnnotation(db, Number(req.params.id));
  if (result.status === 'not_found') return notFound(res, '批注不存在');
  if (result.status === 'sealed') return conflict(res, '该比对已封存，禁止删除批注');
  res.status(204).end();
});

// ---------- 迁移复核 ----------
/** 按比对查看迁移报告：每条迁移批注的候选片段及相似度、自动选中标记与重挂审计 */
app.get('/api/comparisons/:id/migration-report', (req, res) => {
  const report = getMigrationReport(db, Number(req.params.id));
  if (!report) return notFound(res, '比对不存在');
  res.json(report);
});

/** 单条批注的迁移候选片段（供详情页「重新挂载」面板选择） */
app.get('/api/annotations/:id/candidates', (req, res) => {
  const data = getAnnotationCandidates(db, Number(req.params.id));
  if (!data) return notFound(res, '批注不存在');
  res.json(data);
});

/** 待复核批注重新挂载：事务内改挂 + 记录操作者与时间；已封存比对返回 409 */
app.post('/api/annotations/:id/remount', (req, res) => {
  const operator = String(req.body?.operator ?? '').trim();
  if (!operator) return badRequest(res, '操作者必填');
  if (operator.length > 50) return badRequest(res, '操作者姓名过长（最多 50 字）');
  const fragmentId = Number(req.body?.fragment_id);
  if (!Number.isInteger(fragmentId) || fragmentId <= 0) {
    return badRequest(res, '候选片段不合法');
  }
  const result = remountAnnotation(db, Number(req.params.id), fragmentId, operator);
  if (result.status === 'not_found') return notFound(res, '批注不存在');
  if (result.status === 'sealed') return conflict(res, '该比对已封存，禁止重新挂载批注');
  if (result.status === 'not_pending') return conflict(res, '仅待复核状态的批注可以重新挂载');
  if (result.status === 'fragment_mismatch') {
    return badRequest(res, '候选片段不存在或不属于该比对');
  }
  res.json({ annotation: result.annotation });
});

// ---------- 审阅分派 ----------
/** 分派总览：审阅人名单（含每人完成进度）、各片段分派与汇总统计 */
app.get('/api/comparisons/:id/assignments', (req, res) => {
  const board = getAssignmentBoard(db, Number(req.params.id));
  if (!board) return notFound(res, '比对不存在');
  res.json(board);
});

/** 登记审阅人名单（批量）：{names: string[], registered_by?}，同名自动去重 */
app.post('/api/comparisons/:id/reviewers', (req, res) => {
  const raw = req.body?.names;
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > 100) {
    return badRequest(res, '审阅人名单不能为空且不超过 100 人');
  }
  const registeredBy =
    req.body?.registered_by != null ? String(req.body.registered_by).trim().slice(0, 50) : null;
  const result = registerReviewers(db, Number(req.params.id), raw.map(String), registeredBy);
  if (result.status === 'not_found') return notFound(res, '比对不存在');
  if (result.status === 'sealed') return conflict(res, '该比对已封存，禁止登记审阅人');
  if (result.status === 'invalid') {
    return badRequest(res, '审阅人姓名不能为空且不超过 50 字');
  }
  res.status(201).json({ added: result.added, existing: result.existing });
});

/** 从名单移除审阅人；仍存在分派时返回 409 */
app.delete('/api/reviewers/:id', (req, res) => {
  const result = removeReviewer(db, Number(req.params.id));
  if (result.status === 'not_found') return notFound(res, '审阅人不存在');
  if (result.status === 'sealed') return conflict(res, '该比对已封存，禁止调整审阅人名单');
  if (result.status === 'has_assignments') {
    return conflict(res, '该审阅人名下仍有分派，请先回收或转交后再移除');
  }
  res.status(204).end();
});

/** 负责人按片段批量分派：{assignments: [{fragment_id, reviewer_id}], assigned_by}；
 *  已分派的片段不覆盖，逐项在 conflicts 中返回当前负责人 */
app.post('/api/comparisons/:id/assignments', (req, res) => {
  const assignedBy = String(req.body?.assigned_by ?? '').trim();
  if (!assignedBy) return badRequest(res, '分派人（负责人）必填');
  if (assignedBy.length > 50) return badRequest(res, '分派人姓名过长（最多 50 字）');
  const items = req.body?.assignments;
  if (!Array.isArray(items)) return badRequest(res, 'assignments 必须为数组');
  const result = assignFragments(db, Number(req.params.id), items, assignedBy);
  if (result.status === 'not_found') return notFound(res, '比对不存在');
  if (result.status === 'sealed') return conflict(res, '该比对已封存，禁止分派');
  if (result.status === 'invalid') return badRequest(res, result.message);
  res.status(201).json({ assigned: result.assigned, conflicts: result.conflicts });
});

/** 审阅人认领未分派片段：{reviewer_id, expected_version}；
 *  版本号原子校验（未分派时 expected_version = 0），冲突返回 409 与当前负责人，不覆盖 */
app.post('/api/fragments/:id/claim', (req, res) => {
  const reviewerId = Number(req.body?.reviewer_id);
  if (!Number.isInteger(reviewerId) || reviewerId <= 0) {
    return badRequest(res, '认领人必须为本轮比对名单内的审阅人');
  }
  const expectedVersion = Number(req.body?.expected_version);
  if (!Number.isInteger(expectedVersion) || expectedVersion < 0) {
    return badRequest(res, 'expected_version 必须为非负整数（未分派片段为 0）');
  }
  const result = claimFragment(db, Number(req.params.id), reviewerId, expectedVersion);
  if (result.status === 'not_found') return notFound(res, '片段不存在');
  if (result.status === 'sealed') return conflict(res, '该比对已封存，禁止认领');
  if (result.status === 'reviewer_mismatch') {
    return badRequest(res, '认领人必须为本轮比对名单内的审阅人');
  }
  if (result.status === 'version_mismatch') {
    return conflict(res, '分派状态已变化，请刷新后重试', { current: result.current });
  }
  if (result.status === 'conflict') {
    return conflict(
      res,
      `该片段已由「${result.current.reviewer_name}」负责，未覆盖`,
      { current: result.current }
    );
  }
  res.status(201).json({ assignment: result.assignment });
});

/** 标记分派完成：{expected_version, completed_by?}；版本冲突返回 409 与当前状态 */
app.post('/api/assignments/:id/complete', (req, res) => {
  const expectedVersion = Number(req.body?.expected_version);
  if (!Number.isInteger(expectedVersion) || expectedVersion <= 0) {
    return badRequest(res, 'expected_version 必须为正整数');
  }
  const completedBy =
    req.body?.completed_by != null ? String(req.body.completed_by).trim().slice(0, 50) : null;
  const result = completeAssignment(db, Number(req.params.id), expectedVersion, completedBy);
  if (result.status === 'not_found') return notFound(res, '分派不存在');
  if (result.status === 'sealed') return conflict(res, '该比对已封存，禁止变更分派状态');
  if (result.status === 'conflict') {
    const cur = result.current;
    return conflict(
      res,
      cur.status === 'completed'
        ? `该分派已由「${cur.completed_by || cur.reviewer_name}」标记完成，未覆盖`
        : '分派状态已变化，请刷新后重试',
      { current: cur }
    );
  }
  res.json({ assignment: result.assignment });
});

/** 负责人回收未完成分派：{expected_version, operator}；已完成或版本冲突返回 409 */
app.post('/api/assignments/:id/reclaim', (req, res) => {
  const operator = String(req.body?.operator ?? '').trim();
  if (!operator) return badRequest(res, '操作人（负责人）必填');
  if (operator.length > 50) return badRequest(res, '操作人姓名过长（最多 50 字）');
  const expectedVersion = Number(req.body?.expected_version);
  if (!Number.isInteger(expectedVersion) || expectedVersion <= 0) {
    return badRequest(res, 'expected_version 必须为正整数');
  }
  const result = reclaimAssignment(db, Number(req.params.id), expectedVersion);
  if (result.status === 'not_found') return notFound(res, '分派不存在');
  if (result.status === 'sealed') return conflict(res, '该比对已封存，禁止回收分派');
  if (result.status === 'conflict') {
    const cur = result.current;
    return conflict(
      res,
      cur.status === 'completed'
        ? '该分派已完成，不能回收'
        : '分派状态已变化，请刷新后重试',
      { current: cur }
    );
  }
  res.json({ reclaimed: result });
});

// ---------- 导出 ----------
app.get('/api/comparisons/:id/export', (req, res) => {
  const detail = getComparisonDetail(db, Number(req.params.id));
  if (!detail) return notFound(res, '比对不存在');

  const format = String(req.query.format ?? 'json').toLowerCase();
  const { comparison } = detail;
  const filename = `审阅报告-${comparison.project_name}-${comparison.old_label}-vs-${comparison.new_label}`;
  const disposition = (ext: string) =>
    `attachment; filename*=UTF-8''${encodeURIComponent(filename)}.${ext}`;

  if (format === 'json') {
    res.setHeader('Content-Disposition', disposition('json'));
    return res.json(detail);
  }
  if (format === 'csv') {
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', disposition('csv'));
    return res.send(toCsv(detail));
  }
  if (format === 'md' || format === 'markdown') {
    res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
    res.setHeader('Content-Disposition', disposition('md'));
    return res.send(toMarkdown(detail));
  }
  return badRequest(res, 'format 需为 json / csv / md');
});

// ---------- 决议稿 ----------
app.get('/api/comparisons/:id/resolution', (req, res) => {
  const result = buildResolution(db, Number(req.params.id));
  if (result.status === 'not_found') return notFound(res, '比对不存在');
  if (result.status === 'undecided') {
    return conflict(res, '尚有未作结论的差异片段，无法生成决议稿', { undecided: result.ords });
  }
  const { resolution } = result;
  const format = String(req.query.format ?? 'json').toLowerCase();
  if (format === 'md' || format === 'markdown') {
    const { comparison } = resolution;
    const filename = `决议稿-${comparison.project_name}-${comparison.old_label}-vs-${comparison.new_label}`;
    res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename*=UTF-8''${encodeURIComponent(filename)}.md`
    );
    return res.send(resolutionToMarkdown(resolution));
  }
  if (format !== 'json') return badRequest(res, 'format 需为 json / md');
  res.json(resolution);
});

// ---------- 示例数据 ----------
app.post('/api/demo', (_req, res) => {
  const result = seedDemo(db);
  res.status(201).json(result);
});

// ---------- 前端静态资源 ----------
app.use(express.static(path.join(__dirname, '..', 'public')));

// API 404 与统一错误处理
app.use('/api', (_req, res) => res.status(404).json({ error: '接口不存在' }));
app.use(
  (err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    console.error(err);
    res.status(500).json({ error: '服务器内部错误' });
  }
);

app.listen(PORT, () => {
  console.log(`条文变更审阅台已启动：http://localhost:${PORT}`);
  console.log(`数据库文件：${DB_PATH}`);
});
