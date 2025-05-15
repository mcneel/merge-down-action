const core = require('@actions/core');
const github = require('@actions/github');

const token = core.getInput('token', { required: true });
const octokit = github.getOctokit(token);

const pull = github.context.payload.pull_request;

const owner = pull.base.repo.owner.login;
const repo = pull.base.repo.name;
// TODO: use github.context.repo?

const branch_prefix = core.getInput('branch-prefix'); // e.g. 'rhino-' (default: '')

const develop_branch_pattern = new RegExp(`^${branch_prefix}(\\d+)\\.x$`); // e.g. 1.0
const release_branch_pattern = new RegExp(`^${branch_prefix}(\\d+)\\.\\d+$`); // e.g. 1.x

core.debug(`develop_branch_pattern: ${develop_branch_pattern}, release_branch_pattern: ${release_branch_pattern}`);

function flow(branch) {
  // develop branch
  let m = branch.match(develop_branch_pattern)
  if (m !== null) {
    return `${branch_prefix}${parseInt(m[1]) + 1}.x`;
  }

  // release branch
  m = branch.match(release_branch_pattern);
  if (m !== null) {
    return `${branch_prefix}${m[1]}.x`
  }

  return null;
}

async function enablePullRequestAutomerge(number) {
  let params = {
    owner: owner,
    repo: repo,
    pullRequestNumber: number
  }
  let query = `query GetPullRequestId($owner: String!, $repo: String!, $pullRequestNumber: Int!) {
    repository(owner: $owner, name: $repo) {
      pullRequest(number: $pullRequestNumber) {
        id
      }
    }
  }`;
  let response = await octokit.graphql(query, params);
  const prid = response.repository.pullRequest.id;
  // console.log(prid);

  params = {
    pullRequestId: prid,
    mergeMethod: 'MERGE'
  };
  query = `mutation ($pullRequestId: ID!, $mergeMethod: PullRequestMergeMethod!) {
    enablePullRequestAutoMerge(input: {
      pullRequestId: $pullRequestId,
      mergeMethod: $mergeMethod
    }) {
      pullRequest {
        autoMergeRequest {
          enabledAt
          enabledBy {
            login
          }
        }
      }
    }
  }`;
  response = await octokit.graphql(query, params);
  return response.enablePullRequestAutoMerge.pullRequest.autoMergeRequest;
}

async function run() {
  try {
    const base_ref = pull.base.ref;
    const target = flow(base_ref);
    const branch = pull.head.ref;
    console.log(`${branch}: ${base_ref} -> ${target}`);

    if (target === null) {
      core.warning(`Base branch is not a release or development branch: ${base_ref} (branch-prefix: ${branch_prefix})`);
      return;
    }

    // clean up old merge-down branch
    if (branch.match(/-merge-[0-9]+\.([0-9]+|x)$/)) {
      console.log(`Cleaning up old merge-down branch: ${branch}`);
      try {
        await octokit.rest.git.deleteRef({ owner, repo, ref: 'heads/' + branch });
      } catch (err) {
        core.error(err);
        core.warning(`Failed to delete old merge-down branch`);
      }
    }

    // check if target branch exists
    try {
      await octokit.rest.repos.getBranch({owner, repo, branch: target});
    } catch (err) {
      core.error(err);
      core.warning(`Skipping merge-down for non-existant branch: '${target}'`);
      return;
    }

    // create new "merge candidate" branch
    let new_branch = branch + '-merge-' + target;
    console.log(`Creating new remote branch: ${new_branch}`);
    try {
      await octokit.rest.git.createRef({owner, repo, ref: 'refs/heads/' + new_branch, sha: pull.head.sha});
    } catch (err) {
      core.error(err);
      // merge-down branch exists - try again with a unix timestamp thrown in
      new_branch = `${branch}-${+Date.now()}-merge-${target}`;
      core.warning(`Branch exists, creating '${new_branch}' instead`);
      await octokit.rest.git.createRef({owner, repo, ref: 'refs/heads/' + new_branch, sha: pull.head.sha});
    }

    let automerge = true;

    // attempt to merge target branch into new branch (i.e. update)
    console.log(`Updating branch (merging '${target}' into '${new_branch})`);
    try {
      await octokit.rest.repos.merge({owner, repo, base: new_branch, head: target});
    } catch (err) {
      core.error(err);
      core.warning(`GitHub failed to merge ${target} into ${new_branch}`);
      automerge = false;
    }

    // create pull request
    console.log(`Creating pull request to merge '${new_branch}' into ${target}`);
    let title = `Merge branch '${branch}' into ${target}`
    const body = `This pull request was automatically generated from #${pull.number} to ensure that the changes introduced into \`${base_ref}\` by that pull request also make their way into the \`${target}\` branch.

  If there are merge conflicts, try merging \`${target}\` into this branch.
  \`\`\`bash
  git fetch origin
  git checkout -b ${new_branch} origin/${new_branch}
  git merge origin/${target}
  # resolve any conflicts
  git push origin ${new_branch}
  \`\`\`
  `
    const { data: new_pull } = await octokit.rest.pulls.create({owner, repo, title, base: target, head: new_branch, body});
    core.info(`Created pull request: #${new_pull.number}`);

    // enable auto-merge (unless update failed)
    if (automerge) {
      try {
        await enablePullRequestAutomerge(new_pull.number);
      } catch (err) {
        core.error(err);
        core.warning('Failed to enable auto-merge');
      }
      console.log('Auto-merge enabled');
    } else {
      core.warning('Skipping auto-merge because there are merge conflicts');
    }

    // assign pull request to author of orginal pull request
    // (or assignee, if we're merging down a merge-down pull request)
    let actor = pull.user.login;
    console.log(`Assigning pull request to '${actor}'`);
    // TODO: if actor is a bot, try the assignee of the original pull request instead
    // if (pull.user.type === 'Bot' && pull.assignees && pull.assignees.length > 0) {
    // // if (actor == 'mcneel-build' && pull.assignees && pull.assignees.length > 0) {
    //   actor = pull.assignees[0].login
    // }
    try {
      await octokit.rest.issues.update({owner, repo, issue_number: new_pull.number, assignees: [actor]});
    } catch (err) {
      core.error(err);
      core.warning(`Failed to assign #${new_pull.number} to ${actor}`);
    }

  } catch (error) {
    core.setFailed(error.message);
  }
}

run();
