#!/usr/bin/env bash
# Fetches everything the reviewer needs from GitHub into $PR_DIR; the reviewer itself has no network
# access and no token.
#
# Environment: GH_TOKEN, GITHUB_REPOSITORY, PR_NUMBER, BASE_SHA, HEAD_SHA, PR_DIR, REVIEWER_DIR,
# INSTRUCTIONS (path in the checkout), FINDING_MARKER (start of the hidden marker of our findings)
set -euo pipefail

mkdir -p "$PR_DIR"

gh pr view "$PR_NUMBER" --repo "$GITHUB_REPOSITORY" --json title,body \
	--template '{{.title}}{{"\n\n"}}{{.body}}' >"$PR_DIR/description.md"

# The diff of exactly the checked-out commit (`gh pr diff` would give the PR's current head, which
# differs from the checkout if someone pushed after the run started)
gh api "repos/$GITHUB_REPOSITORY/compare/$BASE_SHA...$HEAD_SHA" \
	-H "Accept: application/vnd.github.diff" >"$PR_DIR/diff.patch"

# All comments at the lines (ours, people's, other reviewers'), so that nothing is reported twice,
# also not a finding a person resolved because it does not apply
gh api "repos/$GITHUB_REPOSITORY/pulls/$PR_NUMBER/comments" --paginate \
	--jq '.[] | {path, line, author: .user.login, body: (.body | sub("(?s)<details>.*$"; ""))}' \
	>"$PR_DIR/review-comments.jsonl"

# Our findings from earlier runs whose thread is not resolved yet; the reviewer checks whether each
# one is fixed (field `resolved` of the result)
owner="${GITHUB_REPOSITORY%%/*}"
repo="${GITHUB_REPOSITORY#*/}"
# shellcheck disable=SC2016 # GraphQL variables, not shell
gh api graphql --paginate \
	-F owner="$owner" -F repo="$repo" -F number="$PR_NUMBER" \
	-f query='query($owner: String!, $repo: String!, $number: Int!, $endCursor: String) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      reviewThreads(first: 100, after: $endCursor) {
        pageInfo { hasNextPage endCursor }
        nodes { id isResolved isOutdated path line originalLine comments(first: 1) { nodes { body } } }
      }
    }
  }
}' \
	--jq '.data.repository.pullRequest.reviewThreads.nodes[]
    | select((.isResolved | not) and (.comments.nodes[0].body // "" | contains(env.FINDING_MARKER)))
    | {id, path, line, original_line: .originalLine, outdated: .isOutdated,
       severity: (.comments.nodes[0].body | capture("severity=(?<s>[a-z]+)").s),
       body: (.comments.nodes[0].body | sub("(?s)<details>.*$"; ""))}' \
	>"$PR_DIR/open-findings.jsonl"

# The project's instructions live in the repository; without them a generic template
if [[ -f "$INSTRUCTIONS" ]]; then
	echo "INSTRUCTIONS_PATH=$INSTRUCTIONS" >>"$GITHUB_ENV"
else
	echo "::notice::$INSTRUCTIONS not found; using the generic instructions of the reviewer."
	cp "$REVIEWER_DIR/review-instructions.default.md" "$PR_DIR/review-instructions.md"
	echo "INSTRUCTIONS_PATH=$PR_DIR/review-instructions.md" >>"$GITHUB_ENV"
fi

echo "$(wc -l <"$PR_DIR/open-findings.jsonl") open findings of earlier runs"
