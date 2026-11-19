import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const failure = (message, status = 400) => Object.assign(new Error(message), { status });
const lookup = `query($owner:String!, $repo:String!, $number:Int!, $projects:Boolean!) {
  viewer { login }
  repository(owner:$owner, name:$repo) {
    issue(number:$number) {
      id url title state updatedAt
      projectItems(first:50, includeArchived:false) @include(if:$projects) {
        pageInfo { hasNextPage }
        nodes {
          id updatedAt
          project { id url title field(name:"Status") { ... on ProjectV2SingleSelectField { id options { id name } } } }
          status: fieldValueByName(name:"Status") { ... on ProjectV2ItemFieldSingleSelectValue { optionId name } }
        }
      }
    }
  }
}`;
const changeStatus = `mutation($project:ID!, $item:ID!, $field:ID!, $option:String!) {
  updateProjectV2ItemFieldValue(input:{projectId:$project,itemId:$item,fieldId:$field,value:{singleSelectOptionId:$option}}) {
    projectV2Item { id status:fieldValueByName(name:"Status") { ... on ProjectV2ItemFieldSingleSelectValue { optionId } } }
  }
}`;
const changeIssue = {
    CLOSED: 'mutation($id:ID!) { closeIssue(input:{issueId:$id}) { issue { id state } } }',
    OPEN: 'mutation($id:ID!) { reopenIssue(input:{issueId:$id}) { issue { id state } } }',
};
const lookupLabel = `query($owner:String!, $repo:String!, $number:Int!, $name:String!) {
  viewer { login }
  repository(owner:$owner, name:$repo) {
    label(name:$name) { id name }
    issue(number:$number) { id url title updatedAt labels(first:100) { nodes { id } pageInfo { hasNextPage } } }
  }
}`;
const addLabel = `mutation($issue:ID!, $label:ID!) {
  addLabelsToLabelable(input:{labelableId:$issue,labelIds:[$label]}) {
    labelable { ... on Issue { id labels(first:100) { nodes { id } } } }
  }
}`;

async function graphQL(query, fields, mutation = false) {
    try {
        const { stdout } = await exec('gh', ['api', '--hostname', 'github.com', 'graphql', '-f', `query=${query}`,
            ...Object.entries(fields).flatMap(([key, value]) => [typeof value === 'string' ? '-f' : '-F', `${key}=${value}`])],
        { windowsHide: true, timeout: 15000, maxBuffer: 1024 * 1024, env: { ...process.env, GH_PROMPT_DISABLED: '1' } });
        const payload = JSON.parse(stdout);
        if (!payload.data || payload.errors?.length) throw new Error('Incomplete GitHub response.');
        return payload.data;
    } catch (error) {
        if (error.code === 'ENOENT') throw failure('Install GitHub CLI on the canvas host and sign in to github.com.');
        throw failure(mutation ? 'GitHub did not confirm the write. Reload the target before retrying.' :
            'GitHub could not read this target. Check the URL and the GitHub CLI account’s issue or project access.', 502);
    }
}

const issuePath = /^https:\/\/github\.com\/([a-z0-9-]+)\/([a-z0-9_.-]+)\/issues\/([1-9]\d{0,8})\/?$/i;
const literalLabel = value => typeof value === 'string' && value.trim() === value && value.length > 0 &&
    value.length <= 50 && !/[\x00-\x1f\x7f]|{{/.test(value);

export function issueLabelStep(step) {
    if (step.type !== 'github' || step.operation !== 'add-label' || step.target !== 'issue' ||
        typeof step.repository !== 'string' || typeof step.number !== 'number' && typeof step.number !== 'string' ||
        !literalLabel(step.label)) return null;
    const url = `https://github.com/${step.repository}/issues/${step.number}`;
    const match = issuePath.exec(url);
    if (!match || ['.', '..'].includes(match[2]) || Object.keys(step).some(key =>
        !['id', 'type', 'operation', 'target', 'repository', 'number', 'label', 'continue_on_error'].includes(key))) return null;
    return { action: 'issue-label', url, label: step.label };
}

export function createGitHubChanges(query = graphQL) {
    async function inspect(url, projects) {
        const match = typeof url === 'string' && issuePath.exec(url.trim());
        if (!match) throw failure('Enter the github.com URL of an existing issue, not a pull request.');
        const data = await query(lookup, { owner: match[1], repo: match[2], number: Number(match[3]), projects });
        const issue = data.repository?.issue;
        if (!issue?.id || !issuePath.test(issue.url ?? '') || !data.viewer?.login) throw failure('The GitHub CLI account cannot read this issue.');
        if (projects && issue.projectItems?.pageInfo?.hasNextPage) throw failure('This issue belongs to too many projects to inspect safely in the canvas.');
        return {
            account: data.viewer.login, id: issue.id, url: issue.url, title: issue.title, state: issue.state, updatedAt: issue.updatedAt,
            projects: (issue.projectItems?.nodes ?? []).filter(item => item?.id && item.project?.id && item.project.field?.id &&
                Array.isArray(item.project.field.options)).map(item => ({
                id: item.id, updatedAt: item.updatedAt, project: item.project.id, url: item.project.url, title: item.project.title,
                field: item.project.field.id, current: item.status ? { option: item.status.optionId, name: item.status.name } : null,
                options: item.project.field.options.map(option => ({ id: option.id, name: option.name })),
            })),
        };
    }

    return {
        inspect,
        async prepare(request) {
            if (request.action === 'issue-label') {
                const match = issuePath.exec(request.url);
                if (!match || !literalLabel(request.label)) throw failure('Select a literal issue label declared in a workflow step.');
                const data = await query(lookupLabel, { owner: match[1], repo: match[2], number: Number(match[3]), name: request.label });
                const { issue, label } = data.repository ?? {};
                const account = data.viewer?.login;
                if (!issue?.id || issue.url?.toLowerCase() !== request.url.toLowerCase() || !account ||
                    !label?.id || label.name !== request.label) throw failure('The exact issue or existing repository label could not be verified.');
                if (!Array.isArray(issue.labels?.nodes) || issue.labels.pageInfo?.hasNextPage !== false || issue.labels.nodes.length >= 100) {
                    throw failure('The canvas cannot verify the issue’s complete label set within its limit.');
                }
                if (issue.labels.nodes.some(item => item?.id === label.id)) throw failure('The issue already has this label.');
                return {
                    stamp: [account, issue.id, issue.url, issue.title, issue.updatedAt, label.id, label.name],
                    change: { account, target: issue.url, title: issue.title, field: 'Issue label', before: 'Not applied', after: label.name },
                    async execute() {
                        const response = await query(addLabel, { issue: issue.id, label: label.id }, true);
                        const updated = response.addLabelsToLabelable?.labelable;
                        if (updated?.id !== issue.id || !updated.labels?.nodes?.some(item => item?.id === label.id)) {
                            throw failure('GitHub did not confirm the requested issue label. Reload the target.', 502);
                        }
                        return { externalApplied: true };
                    },
                };
            }
            const projectStatus = request.action === 'project-status';
            const target = await inspect(request.url, projectStatus);
            if (projectStatus) {
                const item = target.projects.find(candidate => candidate.id === request.item);
                const option = item?.options.find(candidate => candidate.id === request.option);
                if (!option || !item) throw failure('Choose a status from a project already linked to this issue.');
                if (option.id === item.current?.option) throw failure('This project item already has that status.');
                return {
                    stamp: [target.account, target.id, target.url, target.title, item, option.id],
                    change: { account: target.account, target: target.url, title: target.title, project: item.url, projectTitle: item.title,
                        field: 'Project status', before: item.current?.name ?? 'Unset', after: option.name },
                    async execute() {
                        const response = await query(changeStatus, { project: item.project, item: item.id, field: item.field, option: option.id }, true);
                        const updated = response.updateProjectV2ItemFieldValue?.projectV2Item;
                        if (updated?.id !== item.id || updated.status?.optionId !== option.id) throw failure('GitHub did not confirm the requested project status. Reload the target.', 502);
                        return { externalApplied: true };
                    },
                };
            }
            const state = request.action === 'close' ? 'CLOSED' : request.action === 'reopen' ? 'OPEN' : null;
            if (!state) throw failure('Choose a supported GitHub change.');
            if (!Object.hasOwn(changeIssue, target.state) || state === target.state) throw failure('This issue does not need that state change.');
            return {
                stamp: [target.account, target.id, target.url, target.title, target.state, target.updatedAt, state],
                change: { account: target.account, target: target.url, title: target.title, field: 'Issue state',
                    before: target.state === 'OPEN' ? 'Open' : 'Closed', after: state === 'OPEN' ? 'Open' : 'Closed' },
                async execute() {
                    const response = await query(changeIssue[state], { id: target.id }, true);
                    const issue = (response.closeIssue ?? response.reopenIssue)?.issue;
                    if (issue?.id !== target.id || issue.state !== state) throw failure('GitHub did not confirm the requested issue state. Reload the target.', 502);
                    return { externalApplied: true };
                },
            };
        },
    };
}
