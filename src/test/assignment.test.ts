import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../db';
import {
  createProject,
  importVersion,
  getComparisonDetail,
  saveFragmentDecision,
  sealComparison,
} from '../service';
import {
  registerReviewers,
  removeReviewer,
  assignFragments,
  claimFragment,
  completeAssignment,
  reclaimAssignment,
  getAssignmentBoard,
  type AssignmentView,
} from '../assignment';
import { toMarkdown } from '../exporter';

const V1 = '第一条 甲。\n\n第二条 乙。\n\n第三条 丙。\n\n第四条 丁。';
const V2 = '第一条 甲（修订）。\n\n第二条 乙。\n\n第三条 丙，新增内容。\n\n第五条 戊。';

function setup() {
  const db = openDb(':memory:');
  const pid = createProject(db, '分派测试办法');
  importVersion(db, pid, 'v1', V1);
  const r2 = importVersion(db, pid, 'v2', V2);
  if (r2.status !== 'ok' || r2.comparisonId == null) throw new Error('夹具异常：比对未生成');
  const comparisonId = r2.comparisonId;
  const frags = db
    .prepare('SELECT id FROM fragments WHERE comparison_id = ? ORDER BY ord')
    .all(comparisonId) as Array<{ id: number }>;
  // 修改 ×2（第一条、第三条）+ 删除（第四条）+ 新增（第五条）
  if (frags.length !== 4) throw new Error('夹具异常：片段数应为 4');
  const reg = registerReviewers(db, comparisonId, ['王法务', '李合规'], '负责人');
  if (reg.status !== 'ok' || reg.added.length !== 2) throw new Error('夹具异常：名单登记失败');
  const [wang, li] = reg.added;
  return { db, pid, comparisonId, frags, wang, li };
}

/** 满足封存条件（全部片段接受、无批注）后封存 */
function seal(db: ReturnType<typeof openDb>, comparisonId: number, fragIds: number[]) {
  for (const id of fragIds) {
    assert.equal(saveFragmentDecision(db, id, 'accepted', null, '负责人').status, 'ok');
  }
  assert.equal(sealComparison(db, comparisonId, '负责人').status, 'ok');
}

/* ---------------- 名单登记 ---------------- */

test('登记审阅人名单：批量登记、请求内与已有姓名去重', () => {
  const { db, comparisonId } = setup();

  const r = registerReviewers(db, comparisonId, ['张审计', '张审计', ' 王法务 ', ''], '负责人');
  assert.equal(r.status, 'ok');
  if (r.status !== 'ok') return;
  // 「王法务」已在名单中（去空白后命中），「张审计」请求内去重后只新增一次
  assert.deepEqual(r.added.map((a) => a.name), ['张审计']);
  assert.deepEqual(r.existing, ['王法务']);

  const board = getAssignmentBoard(db, comparisonId)!;
  assert.deepEqual(
    board.reviewers.map((p) => p.reviewer.name),
    ['王法务', '李合规', '张审计']
  );
  assert.equal(board.reviewers[0].reviewer.created_by, '负责人');

  // 空名单 / 超长姓名 → invalid
  assert.equal(registerReviewers(db, comparisonId, [], null).status, 'invalid');
  assert.equal(registerReviewers(db, comparisonId, ['x'.repeat(51)], null).status, 'invalid');
  // 不存在的比对 → not_found
  assert.equal(registerReviewers(db, 99999, ['甲'], null).status, 'not_found');
});

test('移除审阅人：名下有分派时拒绝，无分派可移除', () => {
  const { db, comparisonId, frags, wang, li } = setup();
  const r = assignFragments(
    db,
    comparisonId,
    [{ fragment_id: frags[0].id, reviewer_id: wang.id }],
    '负责人'
  );
  assert.equal(r.status, 'ok');

  assert.equal(removeReviewer(db, wang.id).status, 'has_assignments');
  assert.equal(removeReviewer(db, li.id).status, 'ok');
  const board = getAssignmentBoard(db, comparisonId)!;
  assert.deepEqual(board.reviewers.map((p) => p.reviewer.name), ['王法务']);
  assert.equal(removeReviewer(db, 99999).status, 'not_found');
});

/* ---------------- 批量分派 ---------------- */

test('批量分派：未分派片段成功；已分派片段冲突并返回当前负责人，不覆盖', () => {
  const { db, comparisonId, frags, wang, li } = setup();

  const first = assignFragments(
    db,
    comparisonId,
    [
      { fragment_id: frags[0].id, reviewer_id: wang.id },
      { fragment_id: frags[1].id, reviewer_id: wang.id },
    ],
    '负责人'
  );
  assert.equal(first.status, 'ok');
  if (first.status !== 'ok') return;
  assert.equal(first.assigned.length, 2);
  assert.equal(first.conflicts.length, 0);
  // 新分派版本号从 1 开始
  assert.ok(first.assigned.every((a) => a.version === 1 && a.status === 'assigned'));
  assert.ok(first.assigned.every((a) => a.assigned_by === '负责人'));

  // 第二批：frag0 已分派给王（冲突不覆盖），frag2 分派给李（成功）
  const second = assignFragments(
    db,
    comparisonId,
    [
      { fragment_id: frags[0].id, reviewer_id: li.id },
      { fragment_id: frags[2].id, reviewer_id: li.id },
    ],
    '负责人'
  );
  assert.equal(second.status, 'ok');
  if (second.status !== 'ok') return;
  assert.equal(second.assigned.length, 1);
  assert.equal(second.assigned[0].fragment_id, frags[2].id);
  assert.equal(second.conflicts.length, 1);
  assert.equal(second.conflicts[0].fragment_id, frags[0].id);
  assert.equal(second.conflicts[0].current!.reviewer_name, '王法务');

  // 冲突未覆盖：frag0 负责人仍是王法务
  const board = getAssignmentBoard(db, comparisonId)!;
  const a0 = board.assignments.find((a) => a.fragment_id === frags[0].id)!;
  assert.equal(a0.reviewer_id, wang.id);
  assert.equal(board.summary.unassigned, 1); // frags[3] 未分派
  assert.equal(board.summary.assigned, 3);
});

test('批量分派校验：跨比对片段 / 非名单审阅人整体拒绝且不写入', () => {
  const { db, pid, comparisonId, frags, wang } = setup();
  const r3 = importVersion(db, pid, 'v3', V1 + '\n\n第六条 己。');
  if (r3.status !== 'ok' || r3.comparisonId == null) throw new Error('夹具异常：v3 未生成');
  const otherFrag = db
    .prepare('SELECT id FROM fragments WHERE comparison_id = ? LIMIT 1')
    .get(r3.comparisonId) as { id: number };

  // 片段不属于本比对
  const bad1 = assignFragments(
    db,
    comparisonId,
    [{ fragment_id: otherFrag.id, reviewer_id: wang.id }],
    '负责人'
  );
  assert.equal(bad1.status, 'invalid');

  // 审阅人不在本比对名单
  const bad2 = assignFragments(
    db,
    comparisonId,
    [{ fragment_id: frags[0].id, reviewer_id: 99999 }],
    '负责人'
  );
  assert.equal(bad2.status, 'invalid');

  // 整体拒绝：不产生任何分派
  const board = getAssignmentBoard(db, comparisonId)!;
  assert.equal(board.assignments.length, 0);
});

/* ---------------- 认领（版本号原子校验） ---------------- */

test('认领：未分派片段认领成功；重复认领冲突并返回当前负责人，不覆盖', () => {
  const { db, comparisonId, frags, wang, li } = setup();

  const r1 = claimFragment(db, frags[0].id, wang.id, 0);
  assert.equal(r1.status, 'ok');
  if (r1.status !== 'ok') return;
  assert.equal(r1.assignment.reviewer_name, '王法务');
  assert.equal(r1.assignment.version, 1);
  assert.equal(r1.assignment.status, 'assigned');

  // 李合规拿着过期视图（仍看到未分派，expected_version=0）认领同一片段 → 冲突
  const r2 = claimFragment(db, frags[0].id, li.id, 0);
  assert.equal(r2.status, 'conflict');
  if (r2.status !== 'conflict') return;
  assert.equal(r2.current.reviewer_name, '王法务');
  assert.equal(r2.current.reviewer_id, wang.id);

  // 冲突不覆盖：数据库中负责人仍是王法务，且只有一条分派
  const board = getAssignmentBoard(db, comparisonId)!;
  assert.equal(board.assignments.length, 1);
  assert.equal(board.assignments[0].reviewer_id, wang.id);
});

test('认领校验：非名单审阅人 / 不存在的片段 / 过期版本号', () => {
  const { db, comparisonId, frags, wang } = setup();

  // 审阅人不在本比对名单内
  assert.equal(claimFragment(db, frags[0].id, 99999, 0).status, 'reviewer_mismatch');
  // 片段不存在
  assert.equal(claimFragment(db, 99999, wang.id, 0).status, 'not_found');

  // 客户端持有过期版本号（以为已有分派 v1，实际未分派）→ 版本冲突
  const stale = claimFragment(db, frags[0].id, wang.id, 1);
  assert.equal(stale.status, 'version_mismatch');
  if (stale.status === 'version_mismatch') assert.equal(stale.current, null);

  // 正确认领后，再用旧的 expected_version=0 认领 → 冲突并返回当前负责人
  assert.equal(claimFragment(db, frags[0].id, wang.id, 0).status, 'ok');
  const again = claimFragment(db, frags[0].id, wang.id, 0);
  assert.equal(again.status, 'conflict');
  const board = getAssignmentBoard(db, comparisonId)!;
  assert.equal(board.assignments.length, 1);
});

/* ---------------- 完成（版本号原子校验） ---------------- */

test('标记完成：版本号原子校验，过期版本冲突并返回当前状态', () => {
  const { db, frags, wang } = setup();
  const claim = claimFragment(db, frags[0].id, wang.id, 0);
  assert.equal(claim.status, 'ok');
  if (claim.status !== 'ok') return;
  const assignment = claim.assignment;

  // 过期版本号 → 冲突，返回当前分派
  const stale = completeAssignment(db, assignment.id, 99, '王法务');
  assert.equal(stale.status, 'conflict');
  if (stale.status === 'conflict') {
    assert.equal(stale.current.status, 'assigned');
    assert.equal(stale.current.version, 1);
  }

  // 正确版本号 → 完成，版本号 +1
  const done = completeAssignment(db, assignment.id, 1, '王法务');
  assert.equal(done.status, 'ok');
  if (done.status !== 'ok') return;
  assert.equal(done.assignment.status, 'completed');
  assert.equal(done.assignment.version, 2);
  assert.equal(done.assignment.completed_by, '王法务');
  assert.ok(done.assignment.completed_at);

  // 已完成的分派再次完成 → 冲突（不覆盖完成人）
  const twice = completeAssignment(db, assignment.id, 2, '李合规');
  assert.equal(twice.status, 'conflict');
  if (twice.status === 'conflict') {
    assert.equal(twice.current.status, 'completed');
    assert.equal(twice.current.completed_by, '王法务');
  }
});

/* ---------------- 回收与转交 ---------------- */

test('负责人回收未完成分派再转交；已完成分派不可回收', () => {
  const { db, comparisonId, frags, wang, li } = setup();
  const claim = claimFragment(db, frags[0].id, wang.id, 0);
  assert.equal(claim.status, 'ok');
  if (claim.status !== 'ok') return;

  // 过期版本号回收 → 冲突
  const stale = reclaimAssignment(db, claim.assignment.id, 99);
  assert.equal(stale.status, 'conflict');

  // 正确版本号回收 → 片段回到未分派
  const reclaimed = reclaimAssignment(db, claim.assignment.id, 1);
  assert.equal(reclaimed.status, 'ok');
  let board = getAssignmentBoard(db, comparisonId)!;
  assert.equal(board.assignments.length, 0);
  assert.equal(board.summary.unassigned, 4);

  // 回收后可再分派（转交给李合规）
  const re = assignFragments(
    db,
    comparisonId,
    [{ fragment_id: frags[0].id, reviewer_id: li.id }],
    '负责人'
  );
  assert.equal(re.status, 'ok');
  if (re.status === 'ok') {
    assert.equal(re.assigned[0].reviewer_name, '李合规');
    assert.equal(re.assigned[0].version, 1);
  }

  // 已完成的分派不可回收
  const board2 = getAssignmentBoard(db, comparisonId)!;
  const a = board2.assignments[0];
  assert.equal(completeAssignment(db, a.id, a.version, '李合规').status, 'ok');
  const done = getAssignmentBoard(db, comparisonId)!.assignments[0];
  const rc = reclaimAssignment(db, done.id, done.version);
  assert.equal(rc.status, 'conflict');
  if (rc.status === 'conflict') assert.equal(rc.current.status, 'completed');
  // 已完成分派保持不动
  board = getAssignmentBoard(db, comparisonId)!;
  assert.equal(board.summary.completed, 1);
});

/* ---------------- 进度汇总与详情集成 ---------------- */

test('分派看板与比对详情：各人完成进度、片段分派状态', () => {
  const { db, comparisonId, frags, wang, li } = setup();
  assignFragments(
    db,
    comparisonId,
    [
      { fragment_id: frags[0].id, reviewer_id: wang.id },
      { fragment_id: frags[1].id, reviewer_id: li.id },
    ],
    '负责人'
  );
  const board0 = getAssignmentBoard(db, comparisonId)!;
  const a0 = board0.assignments.find((a) => a.fragment_id === frags[0].id)!;
  assert.equal(completeAssignment(db, a0.id, a0.version, '王法务').status, 'ok');

  const board = getAssignmentBoard(db, comparisonId)!;
  assert.deepEqual(board.summary, { fragments: 4, unassigned: 2, assigned: 1, completed: 1 });
  const wangP = board.reviewers.find((p) => p.reviewer.id === wang.id)!;
  assert.deepEqual(
    { assigned: wangP.assigned, completed: wangP.completed, total: wangP.total },
    { assigned: 0, completed: 1, total: 1 }
  );
  const liP = board.reviewers.find((p) => p.reviewer.id === li.id)!;
  assert.deepEqual(
    { assigned: liP.assigned, completed: liP.completed, total: liP.total },
    { assigned: 1, completed: 0, total: 1 }
  );

  // 比对详情内嵌分派信息
  const detail = getComparisonDetail(db, comparisonId)!;
  assert.equal(detail.assignments.summary.completed, 1);
  assert.equal(detail.assignments.reviewers.length, 2);
  const f0 = detail.fragments.find((f) => f.id === frags[0].id)!;
  assert.equal(f0.assignment!.reviewer_name, '王法务');
  assert.equal(f0.assignment!.status, 'completed');
  const f2 = detail.fragments.find((f) => f.id === frags[2].id)!;
  assert.equal(f2.assignment, null);

  // 不存在的比对 → null
  assert.equal(getAssignmentBoard(db, 99999), null);
});

/* ---------------- 封存保护 ---------------- */

test('已封存比对禁止一切分派写操作（只读看板不受影响）', () => {
  const { db, comparisonId, frags, wang, li } = setup();
  const claim = claimFragment(db, frags[0].id, wang.id, 0);
  assert.equal(claim.status, 'ok');
  if (claim.status !== 'ok') return;

  seal(db, comparisonId, frags.map((f) => f.id));

  assert.equal(registerReviewers(db, comparisonId, ['新人'], null).status, 'sealed');
  assert.equal(removeReviewer(db, li.id).status, 'sealed');
  assert.equal(
    assignFragments(db, comparisonId, [{ fragment_id: frags[1].id, reviewer_id: li.id }], '负责人')
      .status,
    'sealed'
  );
  assert.equal(claimFragment(db, frags[1].id, li.id, 0).status, 'sealed');
  assert.equal(completeAssignment(db, claim.assignment.id, 1, '王法务').status, 'sealed');
  assert.equal(reclaimAssignment(db, claim.assignment.id, 1).status, 'sealed');

  // 只读看板仍可用，且标记为已封存
  const board = getAssignmentBoard(db, comparisonId)!;
  assert.equal(board.sealed, true);
  assert.equal(board.assignments.length, 1);
});

/* ---------------- 导出 ---------------- */

test('Markdown 导出附分派汇总；JSON 详情含分派信息', () => {
  const { db, comparisonId, frags, wang, li } = setup();
  assignFragments(
    db,
    comparisonId,
    [
      { fragment_id: frags[0].id, reviewer_id: wang.id },
      { fragment_id: frags[1].id, reviewer_id: li.id },
    ],
    '负责人'
  );
  const board = getAssignmentBoard(db, comparisonId)!;
  const a0 = board.assignments.find((a) => a.fragment_id === frags[0].id)!;
  completeAssignment(db, a0.id, a0.version, '王法务');

  const detail = getComparisonDetail(db, comparisonId)!;
  const md = toMarkdown(detail);
  assert.ok(md.includes('## 审阅分派汇总'));
  assert.ok(md.includes('| 审阅人 | 分派片段 | 已完成 | 进行中 | 完成率 |'));
  assert.ok(md.includes('| 王法务 | 1 | 1 | 0 | 100% |'));
  assert.ok(md.includes('| 李合规 | 1 | 0 | 1 | 0% |'));
  assert.ok(md.includes('未分派 2 · 已分派 1 · 已完成 1'));
  // 片段级分派标注
  assert.ok(md.includes('**分派：** 已完成 · 王法务'));
  assert.ok(md.includes('**分派：** 未分派'));

  // JSON 导出直接复用比对详情：分派汇总与片段分派均在响应中
  const json = JSON.parse(JSON.stringify(detail)) as typeof detail;
  assert.equal(json.assignments.summary.completed, 1);
  assert.equal(json.assignments.reviewers.length, 2);
  const f0 = json.fragments.find((f) => f.id === frags[0].id)!;
  assert.equal((f0.assignment as AssignmentView).reviewer_name, '王法务');
});

/* ---------------- 建库 ---------------- */

test('新建库自动包含审阅分派相关表', () => {
  const db = openDb(':memory:');
  const tables = (
    db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as Array<{ name: string }>
  ).map((t) => t.name);
  assert.ok(tables.includes('reviewers'));
  assert.ok(tables.includes('assignments'));
});
