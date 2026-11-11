// Removes the label of the thorough review once it is posted. When someone set the label again
// after this run started, a newer run waits for this one (concurrency) and the label belongs to it.
//
// Environment: LABEL, RUN_CREATED_AT (creation time of this run, from the workflow)
module.exports = async ({ github, context, core }) => {
  const { owner, repo } = context.repo;
  const issue_number = context.payload.pull_request.number;
  const label = process.env.LABEL;

  const events = await github.paginate(github.rest.issues.listEvents, { owner, repo, issue_number, per_page: 100 });
  const lastLabeled = events.filter((e) => e.event === 'labeled' && e.label?.name === label).pop();
  if (lastLabeled && new Date(lastLabeled.created_at) > new Date(process.env.RUN_CREATED_AT)) {
    core.notice(`The label was set again at ${lastLabeled.created_at}; keeping it for that review.`);
    return;
  }
  try {
    await github.rest.issues.removeLabel({ owner, repo, issue_number, name: label });
  } catch (error) {
    // Someone removed it in the meantime
    if (error.status !== 404) throw error;
  }
};
