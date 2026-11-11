// Posts the result of the review job: resolves earlier findings the reviewer found fixed, posts the
// new findings as line comments, approves the PR or requests changes, and updates the summary
// comment.
//
// The verdict does not come from the model but from the open findings: changes are requested while
// a finding with a blocking severity is open, i.e. its review thread is not resolved. A thread is
// resolved by the reviewer when a later run finds the problem gone, or by a person who decides it
// does not apply.
//
// Environment: REVIEW (JSON of the review job), LABEL, REVIEWER, THOROUGH, MODEL, THOROUGH_MODEL,
// HEAD_SHA, VERDICT ('true' or 'false'), BLOCKING (comma-separated severities)
module.exports = async ({ github, context, core }) => {
  const { LABEL, REVIEWER, THOROUGH, MODEL, THOROUGH_MODEL, HEAD_SHA: sha } = process.env;
  const SUMMARY_MARKER = `<!-- ${LABEL}-summary -->`;
  const FINDING_MARKER = `<!-- ${LABEL}-finding `;
  const blocking = new Set(
    (process.env.BLOCKING ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  );

  let review;
  try {
    review = JSON.parse(process.env.REVIEW);
  } catch (error) {
    core.setFailed(`${REVIEWER} returned no valid JSON (${error.message}): ${process.env.REVIEW.slice(0, 500)}`);
    return;
  }

  const { owner, repo } = context.repo;
  const pull_number = context.payload.pull_request.number;
  const icons = { kritisch: '🔴', fehler: '🟠', hinweis: '🟡' };
  const labels = { kritisch: 'Kritisch', fehler: 'Fehler', hinweis: 'Hinweis' };
  const order = ['kritisch', 'fehler', 'hinweis'];

  // A review of an older commit (someone pushed while it ran) still posts its findings, but it
  // neither resolves threads nor sets a verdict; the review of the new head does that
  const { data: pr } = await github.rest.pulls.get({ owner, repo, pull_number });
  const head = pr.head.sha;
  const current = sha === head;

  // Our findings whose thread is not resolved
  const openThreads = async () => {
    const threads = [];
    let cursor = null;
    do {
      const result = await github.graphql(
        `query($owner: String!, $repo: String!, $number: Int!, $cursor: String) {
          repository(owner: $owner, name: $repo) {
            pullRequest(number: $number) {
              reviewThreads(first: 100, after: $cursor) {
                pageInfo { hasNextPage endCursor }
                nodes { id isResolved path line originalLine comments(first: 1) { nodes { body } } }
              }
            }
          }
        }`,
        { owner, repo, number: pull_number, cursor },
      );
      const page = result.repository.pullRequest.reviewThreads;
      for (const t of page.nodes) {
        const body = t.comments.nodes[0]?.body ?? '';
        if (t.isResolved || !body.includes(FINDING_MARKER)) continue;
        threads.push({
          id: t.id,
          path: t.path,
          line: t.line ?? t.originalLine,
          severity: body.match(/severity=([a-z]+)/)?.[1] ?? 'hinweis',
          title: body.match(/^\*\*(.+)\*\*$/m)?.[1] ?? '(ohne Titel)',
        });
      }
      cursor = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
    } while (cursor);
    return threads;
  };

  // 1. Earlier findings the reviewer found fixed: a short reply and the thread resolved. Only our
  // own threads, whatever ids the model returned.
  let open = await openThreads();
  const resolvedIds = new Set(current ? (review.resolved ?? []) : []);
  const resolvedNow = [];
  for (const t of open.filter((t) => resolvedIds.has(t.id))) {
    try {
      await github.graphql(
        `mutation($thread: ID!, $body: String!) {
          addPullRequestReviewThreadReply(input: { pullRequestReviewThreadId: $thread, body: $body }) { clientMutationId }
        }`,
        { thread: t.id, body: `✅ Im Stand ${sha.slice(0, 7)} behoben (${REVIEWER}-Review).` },
      );
      await github.graphql(
        `mutation($thread: ID!) { resolveReviewThread(input: { threadId: $thread }) { clientMutationId } }`,
        { thread: t.id },
      );
      resolvedNow.push(t);
    } catch (error) {
      core.warning(`Could not resolve the thread of ${t.path}:${t.line}: ${error.message}`);
    }
  }
  const resolvedNowIds = new Set(resolvedNow.map((t) => t.id));
  open = open.filter((t) => !resolvedNowIds.has(t.id));

  // 2. New findings. An automatic and a thorough review of the same commit can report the same
  // finding; the comment jobs run one after the other, so the second skips what the first posted.
  // Compared on the reviewed commit: after a push GitHub moves `line` of older comments,
  // `original_line` keeps the line on the commit they were posted on.
  const posted = await github.paginate(github.rest.pulls.listReviewComments, { owner, repo, pull_number });
  const isPosted = (f) =>
    posted.some(
      (c) =>
        c.original_commit_id === sha &&
        c.path === f.path &&
        c.original_line === f.line &&
        c.body?.includes(`**${f.title}**`),
    );
  const findings = (review.findings ?? [])
    .filter((f) => !isPosted(f))
    .sort((a, b) => order.indexOf(a.severity) - order.indexOf(b.severity));

  // One comment per finding: hidden marker, severity and area, title, reasoning, suggestion, agent prompt
  const commentBody = (f) => {
    const parts = [
      `${FINDING_MARKER}severity=${f.severity} -->`,
      `**${icons[f.severity]} ${labels[f.severity]}** · ${f.category}`,
      `**${f.title}**`,
      f.body,
    ];
    if (f.suggestion !== null && f.suggestion !== undefined) {
      parts.push('```suggestion\n' + f.suggestion.replace(/\n$/, '') + '\n```');
    }
    parts.push(
      '<details>\n<summary>🤖 Prompt für KI-Agenten</summary>\n\n```\n' + f.agent_prompt + '\n```\n\n</details>',
    );
    return parts.join('\n\n');
  };
  const toComment = (f) => ({
    path: f.path,
    line: f.line,
    side: 'RIGHT',
    ...(f.start_line && f.start_line < f.line ? { start_line: f.start_line, start_side: 'RIGHT' } : {}),
    body: commentBody(f),
  });

  // All findings as one review; if GitHub rejects it (e.g. a line outside the diff), each finding on
  // its own, and the ones that still fail only go into the summary
  const notPosted = [];
  if (findings.length > 0) {
    try {
      await github.rest.pulls.createReview({
        owner,
        repo,
        pull_number,
        commit_id: sha,
        event: 'COMMENT',
        comments: findings.map(toComment),
      });
    } catch (error) {
      core.warning(`Review with all comments failed: ${error.message}`);
      for (const f of findings) {
        try {
          await github.rest.pulls.createReviewComment({ owner, repo, pull_number, commit_id: sha, ...toComment(f) });
        } catch (singleError) {
          core.warning(`Comment on ${f.path}:${f.line} failed: ${singleError.message}`);
          notPosted.push(f);
        }
      }
    }
  }

  // 3. Verdict: open findings of earlier runs, the new ones and those that could not be put at a
  // line (they have no thread a person could resolve, so they block until a run no longer finds them)
  const openBlocking = [
    ...open.filter((t) => blocking.has(t.severity)),
    ...findings.filter((f) => blocking.has(f.severity)),
  ];
  let verdict = null;
  if (process.env.VERDICT === 'true' && current) {
    const event = openBlocking.length > 0 ? 'REQUEST_CHANGES' : 'APPROVE';
    const counts = order
      .filter((s) => blocking.has(s))
      .map((s) => [s, openBlocking.filter((x) => x.severity === s).length])
      .filter(([, n]) => n > 0)
      .map(([s, n]) => `${icons[s]} ${n} ${labels[s]}`)
      .join(' · ');
    const body =
      event === 'APPROVE'
        ? `✅ Keine offenen Funde, die einen Merge blockieren (Stand ${sha.slice(0, 7)}).`
        : `Änderungen nötig: ${openBlocking.length} offene${openBlocking.length === 1 ? 'r Fund' : ' Funde'} (${counts}). ` +
          'Ich gebe frei, sobald sie behoben sind oder ihr Thread aufgelöst ist.';
    try {
      await github.rest.pulls.createReview({ owner, repo, pull_number, commit_id: sha, event, body });
      verdict = event;
    } catch (error) {
      // E.g. github-actions without "Allow GitHub Actions to create and approve pull requests"
      core.warning(`Could not submit the verdict ${event}: ${error.message}`);
      verdict = `${event} (fehlgeschlagen)`;
    }
  } else if (process.env.VERDICT === 'true') {
    core.notice(`The PR head moved to ${head.slice(0, 7)}; no verdict for ${sha.slice(0, 7)}.`);
  }

  // 4. Summary comment, updated by every run
  const cell = (text) => String(text).replace(/\|/g, '\\|').replace(/\n/g, ' ');
  const link = (f) => {
    const url = `${context.payload.repository.html_url}/blob/${sha}/${f.path}#L${f.line}`;
    return `[\`${cell(f.path)}:${f.line}\`](${url})`;
  };
  const counts = order
    .map((s) => [s, findings.filter((f) => f.severity === s).length])
    .filter(([, n]) => n > 0)
    .map(([s, n]) => `${icons[s]} ${n} ${labels[s]}`)
    .join(' · ');
  const lines = [
    SUMMARY_MARKER,
    `## 🤖 ${REVIEWER}-Review${THOROUGH === 'true' ? ' (gründlich)' : ''}`,
    '',
    review.summary,
    '',
  ];
  if (verdict === 'APPROVE') lines.push('**Ergebnis:** ✅ Freigegeben', '');
  else if (verdict === 'REQUEST_CHANGES') lines.push('**Ergebnis:** ❌ Änderungen nötig', '');
  else if (verdict) lines.push(`**Ergebnis:** ⚠️ ${verdict}, siehe Log des Workflows`, '');
  if (resolvedNow.length > 0) {
    lines.push(`**${resolvedNow.length} frühere${resolvedNow.length === 1 ? 'r Fund' : ' Funde'} behoben:**`);
    for (const t of resolvedNow) lines.push(`- ~~${cell(t.title)}~~ (\`${cell(t.path)}\`)`);
    lines.push('');
  }
  if (findings.length === 0) {
    lines.push('✅ **Keine neuen Funde.**');
  } else {
    lines.push(`**${findings.length} neue${findings.length === 1 ? 'r Fund' : ' Funde'}:** ${counts}`, '');
    lines.push('| | Fund | Bereich | Stelle |', '| :-: | --- | --- | --- |');
    for (const f of findings) {
      lines.push(`| ${icons[f.severity]} | ${cell(f.title)} | ${cell(f.category)} | ${link(f)} |`);
    }
    lines.push('', 'Details stehen in den Kommentaren an den Zeilen.');
    for (const f of notPosted) {
      lines.push('', '---', '', `Konnte nicht an die Zeile gesetzt werden (${link(f)}):`, '', commentBody(f));
    }
  }
  if (open.length > 0) {
    lines.push('', `Noch offen aus früheren Läufen: ${open.length} (aufgelöste Threads zählen nicht mehr).`);
  }
  lines.push(
    '',
    `<sub>Geprüfter Stand: ${sha.slice(0, 7)} · ${MODEL} · Gründliches Review mit ${THOROUGH_MODEL}: Label \`${LABEL}\` setzen</sub>`,
  );
  const body = lines.join('\n');

  // The newest summary of a bot; an older one may belong to another identity (github-actions before
  // a GitHub App was configured) and cannot be edited, then a new one is created
  const comments = await github.paginate(github.rest.issues.listComments, { owner, repo, issue_number: pull_number });
  const existing = comments.filter((c) => c.user?.type === 'Bot' && c.body?.startsWith(SUMMARY_MARKER)).pop();
  // A thorough review keeps running after a push; when it finishes after the review of the new
  // head, it must not replace that summary (its line comments are posted anyway)
  if (existing && !current && existing.body.includes(`Geprüfter Stand: ${head.slice(0, 7)}`)) {
    core.notice(`The summary already shows the review of ${head.slice(0, 7)}; keeping it.`);
    return;
  }
  if (existing) {
    try {
      await github.rest.issues.updateComment({ owner, repo, comment_id: existing.id, body });
      return;
    } catch (error) {
      if (![403, 404].includes(error.status)) throw error;
      core.notice(`Cannot edit summary ${existing.id} (${error.status}); creating a new one.`);
    }
  }
  await github.rest.issues.createComment({ owner, repo, issue_number: pull_number, body });
};
