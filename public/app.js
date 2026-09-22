'use strict';

/* ================= 基础工具 ================= */

const STATUS_LABEL = { open: '待处理', resolved: '已解决', pending_review: '待复核' };
const TYPE_LABEL = { added: '新增', removed: '删除', changed: '修改' };
const DECISION_LABEL = { accepted: '接受变更', rejected: '拒绝变更', deferred: '暂缓' };
const SOURCE_LABEL = { unchanged: '未变更', new: '采用新版', old: '恢复旧版' };
const ASSIGN_LABEL = { assigned: '已分派', completed: '已完成' };

const app = document.getElementById('app');

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

async function api(method, url, body) {
  const opts = { method, headers: {} };
  if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(url, opts);
  if (!res.ok) {
    let msg = `请求失败（${res.status}）`;
    try {
      const j = await res.json();
      if (j.error) msg = j.error;
    } catch { /* ignore */ }
    throw new Error(msg);
  }
  return res.status === 204 ? null : res.json();
}

let toastTimer = null;
function toast(msg, isErr = false) {
  let el = document.getElementById('toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'toast';
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.className = isErr ? 'toast err show' : 'toast show';
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 3500);
}

const lastAuthor = {
  get: () => localStorage.getItem('review-author') || '',
  set: (v) => localStorage.setItem('review-author', v),
};

const lastSealer = {
  get: () => localStorage.getItem('review-sealer') || '',
  set: (v) => localStorage.setItem('review-sealer', v),
};

const lastLead = {
  get: () => localStorage.getItem('review-lead') || '',
  set: (v) => localStorage.setItem('review-lead', v),
};

const lastReviewer = {
  get: () => localStorage.getItem('review-reviewer') || '',
  set: (v) => localStorage.setItem('review-reviewer', v),
};

/* ================= 视图：项目列表 ================= */

async function renderProjects() {
  const { projects } = await api('GET', '/api/projects');
  app.innerHTML = `
    <section class="panel">
      <div class="panel-head">
        <h2>审阅项目</h2>
        <button class="btn" data-action="load-demo">⚡ 载入示例数据</button>
      </div>
      <form id="create-project-form" class="inline-form">
        <input name="name" required maxlength="100" placeholder="新项目名称，如：《数据安全管理办法》">
        <button class="btn primary" type="submit">新建项目</button>
      </form>
      ${projects.length === 0
        ? '<p class="empty">还没有项目。新建一个项目，或点击「载入示例数据」快速体验完整流程。</p>'
        : `<div class="cards">${projects.map((p) => `
            <a class="card" href="#/projects/${p.id}">
              <div class="card-title">${esc(p.name)}</div>
              <div class="card-meta">${p.version_count} 个版本 · ${p.comparison_count} 轮比对</div>
              <div class="card-meta dim">创建于 ${esc(p.created_at)}</div>
            </a>`).join('')}</div>`}
    </section>`;
}

/* ================= 视图：项目详情 ================= */

async function renderProject(id) {
  const { project, versions, comparisons } = await api('GET', `/api/projects/${id}`);
  app.innerHTML = `
    <nav class="crumbs"><a href="#/">全部项目</a> / ${esc(project.name)}</nav>
    <section class="panel">
      <div class="panel-head">
        <h2>${esc(project.name)}</h2>
        <button class="btn danger" data-action="delete-project" data-id="${project.id}">删除项目</button>
      </div>

      <h3>导入新版本</h3>
      <form id="import-form" data-project="${project.id}" class="import-form">
        <input name="label" required maxlength="100" placeholder="版本标签，如：v2.0 送审稿">
        ${versions.length === 0 ? '' : `
        <label class="baseline-pick">比对基线
          <select name="baseline_version_id">
            ${[...versions]
              .sort((a, b) => b.seq - a.seq)
              .map((v, i) =>
                `<option value="${v.id}">${i === 0 ? '最新版本：' : ''}v${v.seq} ${esc(v.label)}</option>`)
              .join('')}
          </select>
        </label>`}
        <textarea name="content" required rows="9"
          placeholder="粘贴规范全文。段落之间用空行分隔；若无空行，则每行视为一条。"></textarea>
        <button class="btn primary" type="submit">导入并按所选基线比对</button>
        <p class="hint">首个版本仅存档；其后默认与<b>最新版本</b>比对，也可选择项目内任一更早的历史版本作为基线。批注只会从「以所选基线为新版」的最近一轮比对迁移。</p>
      </form>

      <h3>版本记录</h3>
      ${versions.length === 0 ? '<p class="empty">尚未导入任何版本。</p>' : `
        <ol class="version-list">
          ${versions.map((v) => `<li><span class="tag">v${v.seq}</span> ${esc(v.label)}
            <span class="dim">${esc(v.created_at)}</span>
            ${v.baseline_id == null
              ? '<span class="base-chip first">首版 · 仅存档</span>'
              : `<span class="base-chip" title="该版本导入时所选的比对基线">⟂ 基线：v${v.baseline_seq} ${esc(v.baseline_label)}</span>`}
            </li>`).join('')}
        </ol>`}

      <h3>比对记录</h3>
      ${comparisons.length === 0 ? '<p class="empty">导入两个以上版本后，这里会列出差异比对。</p>' : `
        <div class="cards">${comparisons.map((c) => `
          <a class="card${c.sealed_at ? ' sealed' : ''}" href="#/comparisons/${c.id}">
            <div class="card-title">
              ${c.sealed_at
                ? '<span class="seal-badge">🔒 已封存</span>'
                : '<span class="draft-badge">📝 草稿</span>'}
              <span class="seq-tag">v${c.old_seq}</span>
              ${esc(c.old_label)} → <span class="seq-tag">v${c.new_seq}</span> ${esc(c.new_label)}
            </div>
            ${c.new_seq !== c.old_seq + 1
              ? `<div class="base-rel">⟂ 跨版本基线：新版 v${c.new_seq} 以更早的 v${c.old_seq} 为基线（中间隔 ${c.new_seq - c.old_seq - 1} 个版本）</div>`
              : '<div class="base-rel adjacent">相邻版本比对</div>'}
            <div class="card-meta">${c.fragment_count} 处差异 · ${c.annotation_count} 条批注
              ${c.open_count > 0 ? ` · <b class="warn">${c.open_count} 条批注待办</b>` : ''}
              ${!c.sealed_at && c.undecided_count > 0 ? ` · <b class="warn">${c.undecided_count} 个片段未结论</b>` : ''}</div>
            <div class="card-meta dim">
              ${c.sealed_at ? `封存人 ${esc(c.sealed_by || '（未署名）')} · ${esc(c.sealed_at)}` : esc(c.created_at)}
            </div>
          </a>`).join('')}</div>`}
    </section>`;
}

/* ================= 视图：比对详情 ================= */

const cmp = {
  id: null,
  data: null,
  status: 'all',
  author: 'all',
  assignee: 'all',
  onlyAnnotated: false,
  assignPick: new Set(),
  resolution: null,
  showMigrationReport: false,
  migrationReport: null,
  remountFor: null,
  remountCandidates: {},
};

async function renderComparison(id) {
  const data = await api('GET', `/api/comparisons/${id}`);
  if (cmp.id !== id) {
    cmp.status = 'all';
    cmp.author = 'all';
    cmp.assignee = 'all';
    cmp.onlyAnnotated = false;
    cmp.assignPick = new Set();
    cmp.showMigrationReport = false;
    cmp.migrationReport = null;
    cmp.remountFor = null;
    cmp.remountCandidates = {};
  }
  cmp.id = id;
  cmp.data = data;
  cmp.resolution = null; // 结论可能已变化，决议稿需重新生成
  // 剔除已不再是「未分派」的勾选（可能已被他人分派 / 认领）
  cmp.assignPick = new Set(
    [...cmp.assignPick].filter((fid) =>
      data.fragments.some((f) => f.id === fid && !f.assignment))
  );
  if (cmp.showMigrationReport) {
    // 报告保持展开时随详情一起刷新（如刚完成一次重挂）
    cmp.migrationReport = await api('GET', `/api/comparisons/${id}/migration-report`);
  }
  drawComparison();
}

function allAnnotations(data = cmp.data) {
  const anns = [];
  for (const f of data.fragments) anns.push(...f.annotations);
  anns.push(...data.unanchored);
  return anns;
}

function visibleAnnotations(anns) {
  return anns.filter(
    (a) =>
      (cmp.status === 'all' || a.status === cmp.status) &&
      (cmp.author === 'all' || a.author === cmp.author)
  );
}

function annHtml(a) {
  const sealed = !!cmp.data.comparison.sealed_at;
  const migrated = a.migrated_from != null
    ? `<span class="migrated" title="从上一轮比对自动迁移">⤳ 迁移${a.similarity != null ? ` · 相似度 ${(a.similarity * 100).toFixed(0)}%` : ''}</span>`
    : '';
  const remounted = a.remounted_by
    ? `<span class="remounted" title="人工选择候选片段重新挂载">🔄 重挂 · ${esc(a.remounted_by)}${a.remounted_at ? ` · ${esc(a.remounted_at)}` : ''}</span>`
    : '';
  return `
    <div class="ann st-${a.status}">
      <div class="ann-head">
        <b>${esc(a.author)}</b>
        <span class="badge st-${a.status}">${STATUS_LABEL[a.status]}</span>
        ${migrated}
        ${remounted}
        <span class="dim">${esc(a.updated_at)}</span>
      </div>
      <div class="ann-body">${esc(a.content)}</div>
      ${sealed ? '' : `
      <div class="ann-actions">
        <select class="ann-status" data-id="${a.id}" title="更新状态">
          ${Object.entries(STATUS_LABEL).map(([v, l]) =>
            `<option value="${v}" ${v === a.status ? 'selected' : ''}>${l}</option>`).join('')}
        </select>
        <button class="btn small danger" data-action="delete-annotation" data-id="${a.id}">删除</button>
      </div>`}
    </div>`;
}

function decisionHtml(f) {
  const sealed = !!cmp.data.comparison.sealed_at;
  if (sealed) {
    if (!f.decision) return '<div class="decision-box dc-none">封存时该片段无结论记录</div>';
    const who = f.decided_by ? `（${esc(f.decided_by)}${f.decided_at ? ` · ${esc(f.decided_at)}` : ''}）` : '';
    return `
      <div class="decision-box dc-${f.decision}">
        <span class="badge dc-${f.decision}">${DECISION_LABEL[f.decision]}</span>
        ${f.decision === 'deferred' && f.decision_reason
          ? `<span class="decision-reason">暂缓理由：${esc(f.decision_reason)}</span>` : ''}
        <span class="dim">${who}</span>
      </div>`;
  }
  const options = [
    { v: 'accepted', l: '接受变更' },
    { v: 'rejected', l: '拒绝变更' },
    { v: 'deferred', l: '暂缓（需填理由）' },
  ];
  return `
    <div class="decision-box" data-fragment="${f.id}">
      <span class="decision-label">审阅结论：</span>
      <div class="decision-opts" role="radiogroup">
        ${options.map((o) => `
          <label class="decision-opt dc-${o.v}${f.decision === o.v ? ' picked' : ''}">
            <input type="radio" class="decision-radio" name="decision-${f.id}" value="${o.v}"
              ${f.decision === o.v ? 'checked' : ''}>
            ${o.l}
          </label>`).join('')}
      </div>
      <div class="decision-detail" ${f.decision === 'deferred' ? '' : 'hidden'}>
        <input class="decision-reason-input" maxlength="1000" placeholder="必须填写暂缓理由，保存后生效"
          value="${esc(f.decision_reason ?? '')}">
      </div>
      <div class="decision-actions">
        <button class="btn small primary" data-action="save-decision" data-id="${f.id}">保存结论</button>
        <span class="dim">切换选项后点击保存；暂缓需先填写理由</span>
      </div>
      ${f.decision && f.decided_by
        ? `<span class="dim">当前结论提出人：${esc(f.decided_by)}${f.decided_at ? ` · ${esc(f.decided_at)}` : ''}</span>`
        : ''}
    </div>`;
}

function fragHtml(f) {
  const sealed = !!cmp.data.comparison.sealed_at;
  const anns = visibleAnnotations(f.annotations);
  const pos = [
    f.old_start != null ? `旧¶${f.old_start}` : null,
    f.new_start != null ? `新¶${f.new_start}` : null,
  ].filter(Boolean).join(' → ');
  return `
    <div class="fragment ft-${f.type}">
      <div class="frag-head">
        <span class="badge ft-${f.type}">${TYPE_LABEL[f.type]}</span>
        <span class="dim">片段 #${f.ord}${pos ? ` · ${pos}` : ''} · ${f.annotations.length} 条批注</span>
        ${f.decision ? `<span class="badge dc-${f.decision}">${DECISION_LABEL[f.decision]}</span>` : '<span class="badge dc-none">未结论</span>'}
        ${assignBadgeHtml(f)}
        ${assignOpsHtml(f)}
      </div>
      ${f.old_text != null ? `<pre class="frag-text old">${esc(f.old_text)}</pre>` : ''}
      ${f.new_text != null ? `<pre class="frag-text new">${esc(f.new_text)}</pre>` : ''}
      ${decisionHtml(f)}
      <div class="anns">${anns.map(annHtml).join('')}</div>
      ${sealed ? '' : `
      <form class="ann-form" data-fragment="${f.id}">
        <input name="author" required maxlength="50" placeholder="作者" value="${esc(lastAuthor.get())}">
        <input name="content" required maxlength="2000" placeholder="写下审阅意见…">
        <button class="btn small primary" type="submit">批注</button>
      </form>`}
    </div>`;
}

function sealBlockers(data) {
  const blockers = [];
  for (const f of data.fragments) {
    if (!f.decision) blockers.push({ kind: 'undecided_fragment', message: `片段 #${f.ord} 尚未作出审阅结论` });
  }
  for (const a of allAnnotations(data)) {
    if (a.status === 'open') {
      blockers.push({ kind: 'open_annotation', message: `存在未解决批注 #${a.id}${a.fragment_id == null ? '（位于待复核区）' : ''}` });
    } else if (a.status === 'pending_review') {
      blockers.push({ kind: 'pending_review_annotation', message: `存在待复核批注 #${a.id}${a.fragment_id == null ? '（位于待复核区）' : ''}` });
    }
  }
  return blockers;
}

function sealPanelHtml(data) {
  const blockers = sealBlockers(data);
  const undecided = data.stats.decisions.undecided;
  const openAnn = data.stats.annotations.open;
  const pendingAnn = data.stats.annotations.pending_review;
  const canSeal = blockers.length === 0;
  const preview = blockers.slice(0, 8).map((b) => `<li>${esc(b.message)}</li>`).join('');
  const more = blockers.length > 8 ? `<li class="dim">…另有 ${blockers.length - 8} 项</li>` : '';
  return `
    <div class="seal-panel${canSeal ? ' ready' : ''}">
      <div class="seal-summary">
        <h3>🔖 审阅封存</h3>
        <div class="seal-counts">
          <span class="${undecided > 0 ? 'warn' : 'ok'}">未作结论片段：${undecided}</span>
          <span class="${openAnn > 0 ? 'warn' : 'ok'}">未解决批注：${openAnn}</span>
          <span class="${pendingAnn > 0 ? 'warn' : 'ok'}">待复核批注：${pendingAnn}</span>
        </div>
      </div>
      ${blockers.length > 0 ? `
        <ul class="blocker-list">${preview}${more}</ul>
        <p class="hint">所有片段均已有结论，且不存在未解决或待复核批注时，方可封存。</p>` : ''}
      <div class="seal-form-row">
        <input id="seal-by" maxlength="50" placeholder="封存人姓名" value="${esc(lastSealer.get())}">
        <button class="btn primary" data-action="seal" data-id="${data.comparison.id}" ${canSeal ? '' : 'disabled'}>
          ${canSeal ? '确认封存' : '尚有阻塞项，无法封存'}
        </button>
      </div>
    </div>`;
}

/* ================= 审阅分派 ================= */

/** 当前选择的审阅人（名单内），用于认领 / 完成 */
function currentReviewer(data = cmp.data) {
  const name = lastReviewer.get();
  const hit = data.assignments.reviewers.find((p) => p.reviewer.name === name);
  return hit ? hit.reviewer : null;
}

function assignmentPanelHtml(data) {
  const sealed = !!data.comparison.sealed_at;
  const s = data.assignments.summary;
  const reviewers = data.assignments.reviewers;
  const me = currentReviewer(data);
  const pickCount = cmp.assignPick.size;
  return `
    <div class="assign-panel">
      <div class="assign-head">
        <h3>👥 审阅分派</h3>
        <div class="assign-counts">
          <span class="chip as-unassigned${s.unassigned > 0 ? ' hot' : ''}">未分派 ${s.unassigned}</span>
          <span class="chip as-assigned">已分派 ${s.assigned}</span>
          <span class="chip as-completed">已完成 ${s.completed}</span>
        </div>
      </div>
      ${reviewers.length === 0
        ? '<p class="empty">尚未登记审阅人名单。项目负责人登记名单后，即可按片段批量分派。</p>'
        : `<div class="reviewer-list">${reviewers.map((p) => {
            const pct = p.total > 0 ? Math.round((p.completed / p.total) * 100) : 0;
            return `
              <div class="reviewer-item">
                <span class="reviewer-name">${esc(p.reviewer.name)}</span>
                <span class="progress" title="完成 ${p.completed} / ${p.total}"><span class="progress-fill" style="width:${pct}%"></span></span>
                <span class="dim">${p.completed}/${p.total} 完成${p.assigned > 0 ? ` · ${p.assigned} 进行中` : ''}</span>
                ${!sealed && p.total === 0
                  ? `<button class="btn small danger" data-action="remove-reviewer" data-id="${p.reviewer.id}" title="从名单移除（无分派时可移除）">✕</button>`
                  : ''}
              </div>`;
          }).join('')}</div>`}
      ${sealed ? '' : `
      <form id="reviewer-form" class="assign-row">
        <input name="names" maxlength="500" placeholder="登记审阅人：多个姓名用逗号 / 顿号分隔，如：王法务、李合规">
        <button class="btn small primary" type="submit">登记名单</button>
      </form>
      <div class="assign-row">
        <label>负责人
          <input id="lead-name" maxlength="50" placeholder="分派 / 回收操作人" value="${esc(lastLead.get())}">
        </label>
        <label>当前审阅人
          <select id="me-reviewer">
            <option value="">（从名单选择）</option>
            ${reviewers.map((p) =>
              `<option value="${p.reviewer.id}" ${me && me.id === p.reviewer.id ? 'selected' : ''}>${esc(p.reviewer.name)}</option>`).join('')}
          </select>
        </label>
        <span class="dim">「认领」以当前审阅人身份进行；认领冲突时以服务端当前负责人为准</span>
      </div>
      <div class="assign-row">
        <label>批量分派给
          <select id="batch-reviewer">
            <option value="">（选择审阅人）</option>
            ${reviewers.map((p) => `<option value="${p.reviewer.id}">${esc(p.reviewer.name)}</option>`).join('')}
          </select>
        </label>
        <button class="btn small" data-action="pick-unassigned" ${s.unassigned === 0 ? 'disabled' : ''}>全选未分派</button>
        <button class="btn small" data-action="clear-pick" ${pickCount === 0 ? 'disabled' : ''}>清空选择</button>
        <button class="btn small primary" data-action="assign-batch" ${pickCount === 0 ? 'disabled' : ''}>分派所选（${pickCount}）</button>
        <span class="dim">在未分派片段卡片上勾选「分派」后批量提交；已分派片段不会被覆盖</span>
      </div>`}
    </div>`;
}

/** 片段头部的分派状态徽标 */
function assignBadgeHtml(f) {
  const a = f.assignment;
  if (!a) return '<span class="badge as-unassigned">未分派</span>';
  const done = a.status === 'completed' && a.completed_by
    ? ` · 完成人 ${esc(a.completed_by)}`
    : '';
  return `<span class="badge as-${a.status}" title="分派人：${esc(a.assigned_by)} · ${esc(a.assigned_at)}${done}">${ASSIGN_LABEL[a.status]} · ${esc(a.reviewer_name)}</span>`;
}

/** 片段头部的分派操作：勾选批量分派 / 认领 / 标记完成 / 回收 */
function assignOpsHtml(f) {
  if (cmp.data.comparison.sealed_at) return '';
  const a = f.assignment;
  if (!a) {
    const me = currentReviewer();
    return `
      <span class="assign-ops">
        <label class="assign-pick" title="勾选后可在分派面板批量分派">
          <input type="checkbox" class="assign-check" data-id="${f.id}" ${cmp.assignPick.has(f.id) ? 'checked' : ''}> 分派
        </label>
        ${me ? `<button class="btn small" data-action="claim" data-id="${f.id}" title="以「${esc(me.name)}」身份认领该片段">认领</button>` : ''}
      </span>`;
  }
  if (a.status === 'assigned') {
    return `
      <span class="assign-ops">
        <button class="btn small" data-action="complete-assign" data-id="${a.id}" data-version="${a.version}" title="标记「${esc(a.reviewer_name)}」的分派为已完成">标记完成</button>
        <button class="btn small danger" data-action="reclaim-assign" data-id="${a.id}" data-version="${a.version}" title="负责人回收未完成分派，回收后可再分派">回收</button>
      </span>`;
  }
  return '';
}

/* ================= 决议稿 ================= */

function resolutionHtml(r) {
  const paras = r.paragraphs.map((p) => {
    const fragTag = p.fragment_ord != null
      ? `片段 #${p.fragment_ord}（${TYPE_LABEL[p.fragment_type]} · ${DECISION_LABEL[p.decision]}）`
      : '无对应差异片段';
    return `
      <div class="res-para src-${p.source}${p.decision === 'deferred' ? ' is-deferred' : ''}">
        <div class="res-meta">
          <span class="res-ord">¶${p.ord}</span>
          <span class="badge src-${p.source}">${SOURCE_LABEL[p.source]}</span>
          ${p.decision === 'deferred' ? '<span class="badge dc-deferred">暂缓</span>' : ''}
          <span class="dim">${fragTag}</span>
        </div>
        <pre class="res-text">${esc(p.text)}</pre>
      </div>`;
  }).join('');

  const todos = r.todos.map((t) => `
    <li class="todo-item">
      <div>
        <b>片段 #${t.fragment_ord}（${TYPE_LABEL[t.fragment_type]}）</b>
        <span class="dim">${t.kept === 'absent' ? '决议稿暂维持删除（新版不含该段）' : '决议稿暂保留新版内容'}</span>
      </div>
      <div class="todo-reason">暂缓理由：${esc(t.reason)}</div>
      <div class="dim">提出人：${esc(t.decided_by || '（未署名）')}${t.decided_at ? ` · ${esc(t.decided_at)}` : ''}</div>
    </li>`).join('');

  return `
    <div class="resolution-panel">
      <div class="res-head">
        <h3>📄 决议稿 <span class="dim">生成于 ${esc(r.generated_at)} · 共 ${r.stats.total} 段</span></h3>
        <div class="res-actions">
          <a class="btn small" href="/api/comparisons/${cmp.id}/resolution?format=md">⬇ 下载 Markdown（UTF-8）</a>
          <button class="btn small" data-action="close-resolution">收起</button>
        </div>
      </div>
      <div class="stats">
        <span class="chip src-unchanged">未变更 ${r.stats.unchanged}</span>
        <span class="chip src-new">采用新版 ${r.stats.from_new}</span>
        <span class="chip src-old">恢复旧版 ${r.stats.from_old}</span>
        <span class="chip dc-deferred${r.stats.deferred > 0 ? ' hot' : ''}">暂缓待办 ${r.stats.deferred}</span>
      </div>
      ${r.todos.length > 0 ? `
        <div class="todo-box">
          <h4>⏸ 暂缓待办清单（${r.todos.length} 项）</h4>
          <ol>${todos}</ol>
        </div>` : ''}
      <div class="res-body">${paras}</div>
    </div>`;
}

function resolutionBarHtml(data) {
  const undecided = data.stats.decisions.undecided;
  const ready = undecided === 0;
  return `
    <div class="resolution-bar">
      <button class="btn" data-action="gen-resolution" ${ready ? '' : 'disabled'}
        title="${ready ? '依据全部片段结论重建正文' : '尚有片段未作结论'}">📄 生成决议稿</button>
      <span class="dim">${ready
        ? '全部片段已有结论：接受 → 采用新版，拒绝 → 恢复旧版，暂缓 → 暂保留新版并列入待办清单'
        : `尚有 ${undecided} 个片段未作结论，全部有结论后才能生成决议稿`}</span>
    </div>
    ${cmp.resolution ? resolutionHtml(cmp.resolution) : ''}`;
}

/* ================= 迁移复核 ================= */

function truncate(s, n) {
  const t = String(s ?? '');
  return t.length > n ? t.slice(0, n) + '…' : t;
}

function migrationBarHtml() {
  return `
    <div class="migration-bar">
      <button class="btn" data-action="toggle-migration-report">
        ${cmp.showMigrationReport ? '收起迁移复核报告' : '🧭 迁移复核报告'}</button>
      <span class="dim">查看本轮批注迁移的候选片段与相似度；待复核批注可在下方待复核区选择候选片段重新挂载</span>
    </div>
    ${cmp.showMigrationReport && cmp.migrationReport ? migrationReportHtml(cmp.migrationReport) : ''}`;
}

function migrationReportHtml(r) {
  const s = r.summary;
  const items = r.items.map((it) => {
    const mount = it.fragment_ord != null
      ? `当前挂载：片段 #${it.fragment_ord}`
      : '<b class="warn">待复核 · 未挂载片段</b>';
    const candRows = it.candidates.map((c) => `
      <tr${c.auto_chosen ? ' class="auto-chosen"' : ''}>
        <td>${c.rank}</td>
        <td>#${c.fragment_ord}</td>
        <td><span class="badge ft-${c.fragment_type}">${TYPE_LABEL[c.fragment_type]}</span></td>
        <td>${c.side === 'old' ? '旧文本' : '新文本'}</td>
        <td>
          <span class="sim-bar"><span class="sim-fill" style="width:${Math.round(c.similarity * 100)}%"></span></span>
          ${(c.similarity * 100).toFixed(1)}%
        </td>
        <td>${c.auto_chosen ? '✓ 自动选中' : ''}</td>
      </tr>`).join('');
    const remounts = it.remounts.map((l) => `
      <li>🔄 <b>${esc(l.operator)}</b> 于 ${esc(l.created_at)} 重挂：
        ${l.from_fragment_ord != null ? `片段 #${l.from_fragment_ord}` : '未挂载'} → 片段 #${l.to_fragment_ord ?? l.to_fragment_id}${l.similarity != null ? `（相似度 ${(l.similarity * 100).toFixed(0)}%）` : ''}</li>`).join('');
    return `
      <div class="mig-item">
        <div class="mig-head">
          <b>批注 #${it.annotation_id}</b>
          <span>${esc(it.author)}</span>
          <span class="badge st-${it.status}">${STATUS_LABEL[it.status]}</span>
          <span class="migrated">⤳ 迁移${it.similarity != null ? ` · 相似度 ${(it.similarity * 100).toFixed(0)}%` : ''}</span>
          <span class="dim">${mount}</span>
          ${it.remounted_by
            ? `<span class="remounted">🔄 重挂 · ${esc(it.remounted_by)}${it.remounted_at ? ` · ${esc(it.remounted_at)}` : ''}</span>`
            : ''}
        </div>
        <div class="anchor-text">锚点文本：${esc(it.anchor_text ?? '（空）')}</div>
        <div class="mig-content">${esc(it.content)}</div>
        ${it.candidates.length > 0 ? `
          <table class="cand-table">
            <thead><tr><th>#</th><th>片段</th><th>类型</th><th>匹配侧</th><th>相似度</th><th>选中</th></tr></thead>
            <tbody>${candRows}</tbody>
          </table>` : '<p class="dim">迁移时无候选片段记录。</p>'}
        ${it.remounts.length > 0 ? `<ul class="remount-log">${remounts}</ul>` : ''}
      </div>`;
  }).join('');

  return `
    <div class="migration-panel">
      <div class="res-head">
        <h3>🧭 迁移复核报告 <span class="dim">本轮从上一轮比对迁移的批注及候选片段</span></h3>
        <button class="btn small" data-action="toggle-migration-report">收起</button>
      </div>
      <div class="stats">
        <span class="chip">迁移批注 ${s.total}</span>
        <span class="chip st-resolved">自动锚定 ${s.auto_migrated}</span>
        <span class="chip st-pending_review${s.pending_review > 0 ? ' hot' : ''}">待复核 ${s.pending_review}</span>
        <span class="chip">人工重挂 ${s.remounted}</span>
      </div>
      ${r.items.length === 0
        ? '<p class="empty">本轮比对没有从上一轮迁移的批注。</p>'
        : items}
    </div>`;
}

function remountPanelHtml(a) {
  const cached = cmp.remountCandidates[a.id];
  if (!cached) {
    return '<div class="remount-panel"><p class="dim">候选片段加载中…</p></div>';
  }
  if (cached.sealed) {
    return '<div class="remount-panel"><p class="dim">该比对已封存，禁止重新挂载。</p></div>';
  }
  const cands = cached.candidates;
  return `
    <div class="remount-panel" data-annotation="${a.id}">
      <div class="remount-title">🔧 为批注 #${a.id} 选择要重新挂载的候选片段（按迁移时相似度排序）</div>
      ${cands.length === 0
        ? '<p class="empty">迁移时未记录到任何候选片段。</p>'
        : `<div class="remount-cands">
            ${cands.map((c) => `
              <label class="remount-cand">
                <input type="radio" name="remount-frag-${a.id}" value="${c.fragment_id}">
                <span class="badge ft-${c.fragment_type}">${TYPE_LABEL[c.fragment_type]}</span>
                <span class="dim">片段 #${c.fragment_ord} · ${c.side === 'old' ? '旧文本' : '新文本'}侧 · 相似度 ${(c.similarity * 100).toFixed(0)}%</span>
                <span class="remount-text">${esc(truncate(c.side === 'old' ? c.old_text : c.new_text, 90))}</span>
              </label>`).join('')}
          </div>`}
      <div class="remount-actions">
        <input class="remount-operator" maxlength="50" placeholder="操作者姓名（必填）" value="${esc(lastAuthor.get())}">
        <button class="btn small primary" data-action="remount-submit" data-id="${a.id}" ${cands.length === 0 ? 'disabled' : ''}>确认重挂</button>
        <button class="btn small" data-action="remount-cancel">取消</button>
        <span class="dim">重挂后批注状态恢复为「待处理」，并记录操作者与时间</span>
      </div>
    </div>`;
}

function drawComparison() {
  const { comparison, fragments, unanchored, stats } = cmp.data;
  const authors = [...new Set(allAnnotations().map((a) => a.author))].sort();
  const filtering = cmp.status !== 'all' || cmp.author !== 'all';
  const assignFiltering = cmp.assignee !== 'all';

  const shownFragments = fragments.filter((f) => {
    if (assignFiltering) {
      if (cmp.assignee === 'unassigned') {
        if (f.assignment) return false;
      } else if (!f.assignment || String(f.assignment.reviewer_id) !== cmp.assignee) {
        return false;
      }
    }
    if (filtering) return visibleAnnotations(f.annotations).length > 0;
    if (cmp.onlyAnnotated) return f.annotations.length > 0;
    return true;
  });
  const shownUnanchored = visibleAnnotations(unanchored);

  app.innerHTML = `
    <nav class="crumbs">
      <a href="#/">全部项目</a> / <a href="#/projects/${comparison.project_id}">${esc(comparison.project_name)}</a>
      / <span class="seq-tag">v${comparison.old_seq}</span> ${esc(comparison.old_label)} → <span class="seq-tag">v${comparison.new_seq}</span> ${esc(comparison.new_label)}
    </nav>
    <section class="panel">
      <div class="panel-head wrap">
        <h2><span class="seq-tag">v${comparison.old_seq}</span> ${esc(comparison.old_label)} → <span class="seq-tag">v${comparison.new_seq}</span> ${esc(comparison.new_label)}</h2>
        <div class="head-side">
          ${comparison.sealed_at
            ? '<span class="seal-badge big">🔒 已封存</span>'
            : '<span class="draft-badge big">📝 草稿</span>'}
          <div class="export-bar">
            导出：
            <a class="btn small" href="/api/comparisons/${cmp.id}/export?format=json">JSON</a>
            <a class="btn small" href="/api/comparisons/${cmp.id}/export?format=csv">CSV</a>
            <a class="btn small" href="/api/comparisons/${cmp.id}/export?format=md">Markdown</a>
          </div>
        </div>
      </div>

      ${comparison.new_seq !== comparison.old_seq + 1 ? `
        <div class="baseline-banner">
          ⟂ 本轮为<b>跨版本基线</b>比对：以历史版本 <b>v${comparison.old_seq} ${esc(comparison.old_label)}</b>
          为基线，与新版 <b>v${comparison.new_seq} ${esc(comparison.new_label)}</b> 计算差异
          （中间跳过 ${comparison.new_seq - comparison.old_seq - 1} 个版本）。
          批注仅来自以该基线为新版的最近一轮比对。
        </div>` : `
        <div class="baseline-banner adjacent">
          ⟂ 比对基线：上一版本 <b>v${comparison.old_seq} ${esc(comparison.old_label)}</b> → 新版 <b>v${comparison.new_seq} ${esc(comparison.new_label)}</b>
        </div>`}

      ${comparison.sealed_at ? `
        <div class="sealed-banner">
          🔒 本比对已于 <b>${esc(comparison.sealed_at)}</b> 由 <b>${esc(comparison.sealed_by || '（未署名）')}</b> 封存。
          封存后禁止修改片段结论，禁止新增、编辑、改状态或删除批注。
        </div>` : sealPanelHtml(cmp.data)}

      <div class="stats">
        <span class="chip ft-added">新增 ${stats.added}</span>
        <span class="chip ft-removed">删除 ${stats.removed}</span>
        <span class="chip ft-changed">修改 ${stats.changed}</span>
        <span class="chip dc-accepted">接受 ${stats.decisions.accepted}</span>
        <span class="chip dc-rejected">拒绝 ${stats.decisions.rejected}</span>
        <span class="chip dc-deferred">暂缓 ${stats.decisions.deferred}</span>
        <span class="chip dc-none${stats.decisions.undecided > 0 ? ' hot' : ''}">未作结论 ${stats.decisions.undecided}</span>
        <span class="chip st-open${stats.annotations.open > 0 ? ' hot' : ''}">未解决批注 ${stats.annotations.open}</span>
        <span class="chip st-pending_review${stats.annotations.pending_review > 0 ? ' hot' : ''}">待复核批注 ${stats.annotations.pending_review}</span>
        <span class="chip st-resolved">已解决 ${stats.annotations.resolved}</span>
      </div>

      ${assignmentPanelHtml(cmp.data)}

      ${resolutionBarHtml(cmp.data)}

      ${migrationBarHtml()}

      <div class="filter-bar">
        <label>状态
          <select id="filter-status">
            <option value="all">全部</option>
            ${Object.entries(STATUS_LABEL).map(([v, l]) =>
              `<option value="${v}" ${cmp.status === v ? 'selected' : ''}>${l}</option>`).join('')}
          </select>
        </label>
        <label>作者
          <select id="filter-author">
            <option value="all">全部</option>
            ${authors.map((a) =>
              `<option value="${esc(a)}" ${cmp.author === a ? 'selected' : ''}>${esc(a)}</option>`).join('')}
          </select>
        </label>
        <label>审阅人
          <select id="filter-assignee">
            <option value="all">全部</option>
            <option value="unassigned" ${cmp.assignee === 'unassigned' ? 'selected' : ''}>未分派</option>
            ${cmp.data.assignments.reviewers.map((p) =>
              `<option value="${p.reviewer.id}" ${cmp.assignee === String(p.reviewer.id) ? 'selected' : ''}>${esc(p.reviewer.name)}（${p.completed}/${p.total}）</option>`).join('')}
          </select>
        </label>
        <label class="check">
          <input type="checkbox" id="filter-annotated" ${cmp.onlyAnnotated ? 'checked' : ''}>
          只显示含批注的片段
        </label>
        <span class="dim">显示 ${shownFragments.length} / ${fragments.length} 个片段</span>
      </div>

      ${shownUnanchored.length > 0 ? `
        <div class="pending-box">
          <h3>⚠ 待复核：以下批注未能锚定到新片段（${shownUnanchored.length}）</h3>
          ${shownUnanchored.map((a) => `
            <div class="pending-item">
              <div class="anchor-text">锚点文本：${esc(a.anchor_text ?? '（空）')}</div>
              ${annHtml(a)}
              ${!comparison.sealed_at && a.status === 'pending_review'
                ? (cmp.remountFor === a.id
                  ? remountPanelHtml(a)
                  : `<button class="btn small" data-action="remount-open" data-id="${a.id}">🔧 选择候选片段重新挂载</button>`)
                : ''}
            </div>`).join('')}
        </div>` : ''}

      ${shownFragments.length === 0
        ? '<p class="empty">没有符合筛选条件的差异片段。</p>'
        : shownFragments.map(fragHtml).join('')}
    </section>`;
}

/* ================= 事件处理 ================= */

document.addEventListener('submit', async (e) => {
  const form = e.target;
  try {
    if (form.id === 'create-project-form') {
      e.preventDefault();
      const name = form.elements.name.value.trim();
      const { id } = await api('POST', '/api/projects', { name });
      location.hash = `#/projects/${id}`;
    } else if (form.id === 'import-form') {
      e.preventDefault();
      const projectId = form.dataset.project;
      const label = form.elements.label.value.trim();
      const content = form.elements.content.value;
      const baselineSel = form.elements.baseline_version_id;
      const body = { label, content };
      if (baselineSel && baselineSel.value) body.baseline_version_id = Number(baselineSel.value);
      const r = await api('POST', `/api/projects/${projectId}/versions`, body);
      if (r.comparisonId) {
        const mig = r.migration;
        let migText = '';
        if (mig) {
          if (mig.status === 'migrated') {
            migText = `；批注迁移 ${mig.migrated} 条、待复核 ${mig.pending} 条`;
          } else {
            migText = `；批注未迁移（${mig.message || '没有以所选基线为新版的历史比对'}）`;
          }
        }
        const base = r.baselineVersionId == null ? '' : '（按所选基线）';
        toast(`比对完成${base}：${r.fragmentCount} 处差异${migText}`);
        location.hash = `#/comparisons/${r.comparisonId}`;
      } else {
        toast('首个版本已存档，再导入一个版本即可比对');
        await renderProject(projectId);
      }
    } else if (form.classList.contains('ann-form')) {
      e.preventDefault();
      const author = form.elements.author.value.trim();
      const content = form.elements.content.value.trim();
      lastAuthor.set(author);
      await api('POST', `/api/fragments/${form.dataset.fragment}/annotations`, { author, content });
      await renderComparison(cmp.id);
      toast('批注已添加');
    } else if (form.id === 'reviewer-form') {
      e.preventDefault();
      const names = form.elements.names.value
        .split(/[,，、;；\n]+/)
        .map((s) => s.trim())
        .filter(Boolean);
      if (names.length === 0) {
        toast('请填写审阅人姓名（多个用逗号分隔）', true);
        return;
      }
      const leadInput = document.getElementById('lead-name');
      const lead = leadInput ? leadInput.value.trim() : '';
      if (lead) lastLead.set(lead);
      const r = await api('POST', `/api/comparisons/${cmp.id}/reviewers`, {
        names,
        registered_by: lead || null,
      });
      toast(
        `名单已登记：新增 ${r.added.length} 人` +
          (r.existing.length ? `，${r.existing.length} 人已在名单中` : '')
      );
      await renderComparison(cmp.id);
    }
  } catch (err) {
    toast(err.message, true);
  }
});

document.addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-action]');
  if (!btn) return;
  const action = btn.dataset.action;
  try {
    if (action === 'load-demo') {
      btn.disabled = true;
      const r = await api('POST', '/api/demo');
      const mig = r.migration;
      let migText = '';
      if (mig) {
        migText =
          mig.status === 'migrated'
            ? `：批注迁移 ${mig.migrated} 条、待复核 ${mig.pending} 条`
            : '：批注未迁移';
      }
      toast('示例数据已载入' + migText);
      location.hash = `#/comparisons/${r.comparisons[r.comparisons.length - 1]}`;
    } else if (action === 'delete-project') {
      if (!confirm('确定删除该项目及其全部版本、比对与批注？')) return;
      await api('DELETE', `/api/projects/${btn.dataset.id}`);
      location.hash = '#/';
    } else if (action === 'delete-annotation') {
      if (!confirm('确定删除这条批注？')) return;
      await api('DELETE', `/api/annotations/${btn.dataset.id}`);
      await renderComparison(cmp.id);
      toast('批注已删除');
    } else if (action === 'save-decision') {
      const box = btn.closest('.decision-box');
      const checked = box.querySelector('input[type=radio]:checked');
      const fragmentId = box.dataset.fragment;
      if (!checked) {
        toast('请先选择「接受变更 / 拒绝变更 / 暂缓」', true);
        return;
      }
      const decision = checked.value;
      const reasonInput = box.querySelector('.decision-reason-input');
      const reason = reasonInput ? reasonInput.value.trim() : '';
      if (decision === 'deferred' && !reason) {
        toast('暂缓必须填写理由', true);
        reasonInput?.focus();
        return;
      }
      btn.disabled = true;
      try {
        await api('PATCH', `/api/fragments/${fragmentId}/decision`, {
          decision,
          reason: decision === 'deferred' ? reason : null,
          decided_by: lastAuthor.get() || null,
        });
        toast('片段结论已保存');
        await renderComparison(cmp.id);
      } finally {
        btn.disabled = false;
      }
    } else if (action === 'gen-resolution') {
      btn.disabled = true;
      try {
        cmp.resolution = await api('GET', `/api/comparisons/${cmp.id}/resolution`);
        drawComparison();
        toast('决议稿已生成');
      } catch (err) {
        await renderComparison(cmp.id);
        throw err;
      }
    } else if (action === 'close-resolution') {
      cmp.resolution = null;
      drawComparison();
    } else if (action === 'toggle-migration-report') {
      cmp.showMigrationReport = !cmp.showMigrationReport;
      if (cmp.showMigrationReport && !cmp.migrationReport) {
        cmp.migrationReport = await api('GET', `/api/comparisons/${cmp.id}/migration-report`);
      }
      drawComparison();
    } else if (action === 'remount-open') {
      cmp.remountFor = Number(btn.dataset.id);
      drawComparison();
      // 懒加载该批注的迁移候选片段
      const data = await api('GET', `/api/annotations/${cmp.remountFor}/candidates`);
      cmp.remountCandidates[cmp.remountFor] = data;
      drawComparison();
    } else if (action === 'remount-cancel') {
      cmp.remountFor = null;
      drawComparison();
    } else if (action === 'remount-submit') {
      const annId = Number(btn.dataset.id);
      const panel = btn.closest('.remount-panel');
      const checked = panel.querySelector('input[type=radio]:checked');
      if (!checked) {
        toast('请先选择一个候选片段', true);
        return;
      }
      const operatorInput = panel.querySelector('.remount-operator');
      const operator = operatorInput.value.trim();
      if (!operator) {
        toast('请填写操作者姓名', true);
        operatorInput.focus();
        return;
      }
      btn.disabled = true;
      try {
        await api('POST', `/api/annotations/${annId}/remount`, {
          fragment_id: Number(checked.value),
          operator,
        });
        lastAuthor.set(operator);
        cmp.remountFor = null;
        delete cmp.remountCandidates[annId];
        toast('批注已重新挂载，状态恢复为「待处理」');
        await renderComparison(cmp.id);
      } finally {
        btn.disabled = false;
      }
    } else if (action === 'seal') {
      const input = document.getElementById('seal-by');
      const sealedBy = input.value.trim();
      if (!sealedBy) {
        toast('请填写封存人姓名', true);
        input.focus();
        return;
      }
      btn.disabled = true;
      try {
        const res = await fetch(`/api/comparisons/${btn.dataset.id}/seal`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sealed_by: sealedBy }),
        });
        const j = await res.json().catch(() => null);
        if (!res.ok) {
          if (j?.blockers?.length) {
            toast(`封存被阻塞：${j.blockers[0].message} 等 ${j.blockers.length} 项`, true);
          } else {
            toast(j?.error || `封存失败（${res.status}）`, true);
          }
          await renderComparison(cmp.id);
          return;
        }
        lastSealer.set(sealedBy);
        toast('已封存：片段结论与批注均已锁定');
        await renderComparison(cmp.id);
      } finally {
        btn.disabled = false;
      }
    } else if (action === 'remove-reviewer') {
      if (!confirm('确定把该审阅人从名单移除？（名下无分派时才可移除）')) return;
      await api('DELETE', `/api/reviewers/${btn.dataset.id}`);
      toast('审阅人已移除');
      await renderComparison(cmp.id);
    } else if (action === 'pick-unassigned') {
      for (const f of cmp.data.fragments) {
        if (!f.assignment) cmp.assignPick.add(f.id);
      }
      drawComparison();
    } else if (action === 'clear-pick') {
      cmp.assignPick.clear();
      drawComparison();
    } else if (action === 'assign-batch') {
      const reviewerSel = document.getElementById('batch-reviewer');
      const reviewerId = reviewerSel ? reviewerSel.value : '';
      if (!reviewerId) {
        toast('请先选择要分派给的审阅人', true);
        reviewerSel?.focus();
        return;
      }
      const leadInput = document.getElementById('lead-name');
      const lead = leadInput ? leadInput.value.trim() : '';
      if (!lead) {
        toast('请填写负责人姓名（分派操作人）', true);
        leadInput?.focus();
        return;
      }
      if (cmp.assignPick.size === 0) {
        toast('请先在未分派片段上勾选「分派」', true);
        return;
      }
      btn.disabled = true;
      try {
        const r = await api('POST', `/api/comparisons/${cmp.id}/assignments`, {
          assigned_by: lead,
          assignments: [...cmp.assignPick].map((fid) => ({
            fragment_id: fid,
            reviewer_id: Number(reviewerId),
          })),
        });
        lastLead.set(lead);
        cmp.assignPick.clear();
        toast(
          `已分派 ${r.assigned.length} 个片段` +
            (r.conflicts.length
              ? `；${r.conflicts.length} 个片段已被「${r.conflicts[0].current.reviewer_name}」等负责，未覆盖`
              : '')
        );
        await renderComparison(cmp.id);
      } finally {
        btn.disabled = false;
      }
    } else if (action === 'claim') {
      const me = currentReviewer();
      if (!me) {
        toast('请先在「审阅分派」面板选择当前审阅人', true);
        return;
      }
      btn.disabled = true;
      try {
        await api('POST', `/api/fragments/${btn.dataset.id}/claim`, {
          reviewer_id: me.id,
          expected_version: 0,
        });
        toast(`认领成功：该片段由「${me.name}」负责`);
      } finally {
        // 无论成功与否都刷新：认领冲突时可看到服务端返回的当前负责人
        await renderComparison(cmp.id);
      }
    } else if (action === 'complete-assign') {
      const me = currentReviewer();
      btn.disabled = true;
      try {
        await api('POST', `/api/assignments/${btn.dataset.id}/complete`, {
          expected_version: Number(btn.dataset.version),
          completed_by: me ? me.name : null,
        });
        toast('该分派已标记完成');
      } finally {
        await renderComparison(cmp.id);
      }
    } else if (action === 'reclaim-assign') {
      const leadInput = document.getElementById('lead-name');
      const lead = leadInput ? leadInput.value.trim() : '';
      if (!lead) {
        toast('请先在「审阅分派」面板填写负责人姓名（回收操作人）', true);
        leadInput?.focus();
        return;
      }
      if (!confirm('确定回收该未完成分派？回收后片段回到「未分派」，可再分派给他人。')) return;
      btn.disabled = true;
      try {
        await api('POST', `/api/assignments/${btn.dataset.id}/reclaim`, {
          expected_version: Number(btn.dataset.version),
          operator: lead,
        });
        lastLead.set(lead);
        toast('分派已回收，片段回到「未分派」');
      } finally {
        await renderComparison(cmp.id);
      }
    }
  } catch (err) {
    toast(err.message, true);
  }
});

document.addEventListener('change', async (e) => {
  const t = e.target;
  try {
    if (t.classList.contains('decision-radio')) {
      const box = t.closest('.decision-box');
      const detail = box.querySelector('.decision-detail');
      detail.hidden = t.value !== 'deferred';
      box.querySelectorAll('.decision-opt').forEach((el) => {
        el.classList.toggle('picked', el.querySelector('input').checked);
      });
    } else if (t.classList.contains('ann-status')) {
      await api('PATCH', `/api/annotations/${t.dataset.id}`, { status: t.value });
      await renderComparison(cmp.id);
      toast('状态已更新');
    } else if (t.id === 'filter-status') {
      cmp.status = t.value;
      drawComparison();
    } else if (t.id === 'filter-author') {
      cmp.author = t.value;
      drawComparison();
    } else if (t.id === 'filter-assignee') {
      cmp.assignee = t.value;
      drawComparison();
    } else if (t.id === 'filter-annotated') {
      cmp.onlyAnnotated = t.checked;
      drawComparison();
    } else if (t.id === 'me-reviewer') {
      const hit = cmp.data.assignments.reviewers.find(
        (p) => String(p.reviewer.id) === t.value
      );
      lastReviewer.set(hit ? hit.reviewer.name : '');
      drawComparison();
    } else if (t.id === 'lead-name') {
      lastLead.set(t.value.trim());
    } else if (t.classList.contains('assign-check')) {
      const fid = Number(t.dataset.id);
      if (t.checked) cmp.assignPick.add(fid);
      else cmp.assignPick.delete(fid);
      // 只更新批量分派按钮的计数，避免整页重绘导致滚动位置丢失
      const n = cmp.assignPick.size;
      const batchBtn = document.querySelector('[data-action="assign-batch"]');
      if (batchBtn) {
        batchBtn.textContent = `分派所选（${n}）`;
        batchBtn.disabled = n === 0;
      }
      const clearBtn = document.querySelector('[data-action="clear-pick"]');
      if (clearBtn) clearBtn.disabled = n === 0;
    }
  } catch (err) {
    toast(err.message, true);
  }
});

/* ================= 路由 ================= */

async function route() {
  const hash = location.hash || '#/';
  const mProject = hash.match(/^#\/projects\/(\d+)$/);
  const mCompare = hash.match(/^#\/comparisons\/(\d+)$/);
  try {
    if (mCompare) await renderComparison(Number(mCompare[1]));
    else if (mProject) await renderProject(Number(mProject[1]));
    else await renderProjects();
  } catch (err) {
    app.innerHTML = `<section class="panel"><p class="error">${esc(err.message)}</p>
      <p><a href="#/">返回首页</a></p></section>`;
  }
}

window.addEventListener('hashchange', route);
route();
