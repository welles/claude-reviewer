// Whether a thorough review of the same PR and commit exists, so that the automatic review can skip
// it. A thorough review that failed or was cancelled does not count, nor one whose comments could
// not be posted. Returns 'true' or 'false' (actions/github-script, result-encoding string).
//
// Runs are found through the calling workflow (this one is reusable, so the runs belong to the
// caller) and the job name, which contains the PR number: another PR may point at the same commit,
// and its review is posted there. Job names of reusable workflows read "<caller job> / <job>".
module.exports = async ({ github, context, core }) => {
  const { owner, repo } = context.repo;
  const pr = context.payload.pull_request.number;
  const sha = context.payload.pull_request.head.sha;
  const short = (name) => name.split(' / ').pop();

  const { data: current } = await github.rest.actions.getWorkflowRun({ owner, repo, run_id: context.runId });
  const runs = await github.paginate(github.rest.actions.listWorkflowRuns, {
    owner,
    repo,
    workflow_id: current.workflow_id,
    head_sha: sha,
    per_page: 100,
  });
  for (const run of runs) {
    if (run.id === context.runId) continue;
    const jobs = await github.paginate(github.rest.actions.listJobsForWorkflowRun, {
      owner,
      repo,
      run_id: run.id,
      filter: 'latest',
      per_page: 100,
    });
    const thorough = jobs.some(
      (j) => short(j.name) === `Thorough review #${pr}` && (j.conclusion === null || j.conclusion === 'success'),
    );
    const posted = jobs.every(
      (j) => short(j.name) !== 'comment' || [null, 'success', 'skipped'].includes(j.conclusion),
    );
    if (thorough && posted) {
      core.notice(`Run ${run.id} reviews this commit thoroughly; skipping the automatic review.`);
      return 'true';
    }
  }
  return 'false';
};
