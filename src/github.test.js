import { beforeEach, describe, expect, it, vi } from 'vitest';
import { clearCache, createDashboardClient } from './github';

class MemoryStorage {
  constructor() {
    this.values = new Map();
  }

  get length() {
    return this.values.size;
  }

  key(index) {
    return [...this.values.keys()][index] ?? null;
  }

  getItem(key) {
    return this.values.get(key) ?? null;
  }

  setItem(key, value) {
    this.values.set(key, String(value));
  }

  removeItem(key) {
    this.values.delete(key);
  }

  clear() {
    this.values.clear();
  }
}

function repository(fullName) {
  const [owner, name] = fullName.split('/');
  return { full_name: fullName, name, owner: { login: owner } };
}

function createOctokit() {
  const octokit = {
    repos: {
      get: vi.fn(),
      listForOrg: vi.fn(),
      listForUser: vi.fn(),
      listForAuthenticatedUser: vi.fn(),
    },
    users: {
      getByUsername: vi.fn(),
    },
  };
  octokit.paginate = vi.fn((endpoint, params) => endpoint(params));
  return octokit;
}

beforeEach(() => {
  Object.defineProperty(globalThis, 'localStorage', {
    value: new MemoryStorage(),
    configurable: true,
  });
});

describe('repository resolution', () => {
  it('resolves exact repositories locally without an API call', async () => {
    const octokit = createOctokit();
    const client = createDashboardClient('token', octokit);

    const first = await client.fetchMatchedRepositories(['mlahr/upag']);
    const second = await client.fetchMatchedRepositories(['mlahr/upag']);

    expect(first).toEqual({
      repositories: [repository('mlahr/upag')],
      warnings: [],
    });
    expect(second).toEqual(first);
    expect(octokit.repos.get).not.toHaveBeenCalled();
    expect(localStorage.getItem('gh-cache-repositories-v2')).toBeNull();
  });

  it('matches organization wildcards case-insensitively without matching the base name', async () => {
    const octokit = createOctokit();
    octokit.users.getByUsername.mockResolvedValue({
      data: { login: 'MenschMachine', type: 'Organization' },
    });
    octokit.repos.listForOrg.mockResolvedValue([
      repository('MenschMachine/pdfdancer'),
      repository('MenschMachine/pdfdancer-mcp'),
      repository('MenschMachine/PDFDANCER-client-java'),
    ]);

    const result = await createDashboardClient('token', octokit)
      .fetchMatchedRepositories(['menschmachine/pdfdancer-*']);

    expect(result.repositories.map(repo => repo.full_name)).toEqual([
      'MenschMachine/pdfdancer-mcp',
      'MenschMachine/PDFDANCER-client-java',
    ]);
    expect(result.warnings).toEqual([]);
    expect(octokit.repos.listForOrg).toHaveBeenCalledWith({
      org: 'MenschMachine',
      per_page: 100,
    });
  });

  it('combines public and token-accessible repositories for user wildcards', async () => {
    const octokit = createOctokit();
    octokit.users.getByUsername.mockResolvedValue({
      data: { login: 'mlahr', type: 'User' },
    });
    octokit.repos.listForUser.mockResolvedValue([
      repository('mlahr/upag-public'),
    ]);
    octokit.repos.listForAuthenticatedUser.mockResolvedValue([
      repository('mlahr/upag-public'),
      repository('mlahr/upag-private'),
      repository('another-owner/unrelated'),
    ]);

    const result = await createDashboardClient('token', octokit)
      .fetchMatchedRepositories(['mlahr/upag-*']);

    expect(result.repositories.map(repo => repo.full_name)).toEqual([
      'mlahr/upag-public',
      'mlahr/upag-private',
    ]);
    expect(result.warnings).toEqual([]);
    expect(octokit.repos.listForAuthenticatedUser).toHaveBeenCalledTimes(1);
  });

  it('keeps user wildcard results when one inventory source fails', async () => {
    const octokit = createOctokit();
    octokit.users.getByUsername.mockResolvedValue({
      data: { login: 'mlahr', type: 'User' },
    });
    octokit.repos.listForUser.mockRejectedValue(
      Object.assign(new Error('Forbidden'), { status: 403 })
    );
    octokit.repos.listForAuthenticatedUser.mockResolvedValue([
      repository('mlahr/upag-private'),
    ]);

    const result = await createDashboardClient('token', octokit)
      .fetchMatchedRepositories(['mlahr/upag-*']);

    expect(result.repositories).toEqual([repository('mlahr/upag-private')]);
    expect(result.warnings).toEqual([{
      target: 'mlahr public repositories',
      status: 403,
      message: 'Forbidden',
    }]);
  });

  it('returns exact repositories unvalidated alongside wildcard matches', async () => {
    const octokit = createOctokit();
    octokit.users.getByUsername.mockResolvedValue({
      data: { login: 'MenschMachine', type: 'Organization' },
    });
    octokit.repos.listForOrg.mockResolvedValue([
      repository('MenschMachine/pdfdancer-mcp'),
    ]);

    const result = await createDashboardClient('token', octokit)
      .fetchMatchedRepositories(['mlahr/missing', 'MenschMachine/pdfdancer-*']);

    expect(result.repositories).toEqual([
      repository('mlahr/missing'),
      repository('MenschMachine/pdfdancer-mcp'),
    ]);
    expect(result.warnings).toEqual([]);
    expect(octokit.repos.get).not.toHaveBeenCalled();
  });

  it('warns about malformed patterns without making an API request', async () => {
    const octokit = createOctokit();

    const result = await createDashboardClient('token', octokit)
      .fetchMatchedRepositories(['missing-slash', '*/repository']);

    expect(result.repositories).toEqual([]);
    expect(result.warnings).toHaveLength(2);
    expect(octokit.repos.get).not.toHaveBeenCalled();
    expect(octokit.users.getByUsername).not.toHaveBeenCalled();
  });
});

describe('unified repository cache', () => {
  it('keeps independently cached resolutions in one versioned entry', async () => {
    const octokit = createOctokit();
    octokit.users.getByUsername.mockImplementation(({ username }) =>
      Promise.resolve({ data: { login: username, type: 'Organization' } })
    );
    octokit.repos.listForOrg.mockImplementation(({ org }) =>
      Promise.resolve([repository(`${org}/alpha`), repository(`${org}/beta`)])
    );
    const client = createDashboardClient('token', octokit);

    await client.fetchMatchedRepositories(['alpha/*', 'beta/*']);

    const cache = JSON.parse(localStorage.getItem('gh-cache-repositories-v2'));
    expect(Object.keys(cache.entries).sort()).toEqual([
      'inventory:organization:alpha',
      'inventory:organization:beta',
      'owner:alpha',
      'owner:beta',
    ]);
  });

  it('refreshes only stale resolutions', async () => {
    const octokit = createOctokit();
    octokit.users.getByUsername.mockResolvedValue({
      data: { login: 'MenschMachine', type: 'Organization' },
    });
    octokit.repos.listForOrg.mockResolvedValue([
      repository('MenschMachine/pdfdancer-mcp'),
    ]);
    const client = createDashboardClient('token', octokit);

    await client.fetchMatchedRepositories(['MenschMachine/pdfdancer-*']);
    const cache = JSON.parse(localStorage.getItem('gh-cache-repositories-v2'));
    cache.entries['inventory:organization:menschmachine'].timestamp = 0;
    localStorage.setItem('gh-cache-repositories-v2', JSON.stringify(cache));

    await client.fetchMatchedRepositories(
      ['MenschMachine/pdfdancer-*'],
      { reposTtl: 60_000 }
    );

    expect(octokit.users.getByUsername).toHaveBeenCalledTimes(1);
    expect(octokit.repos.listForOrg).toHaveBeenCalledTimes(2);
  });

  it('ignores corrupted cache data and removes legacy repository entries', async () => {
    localStorage.setItem('gh-cache-repositories-v2', '{bad json');
    localStorage.setItem('gh-cache-repos-MenschMachine', '{}');
    const octokit = createOctokit();
    octokit.users.getByUsername.mockResolvedValue({
      data: { login: 'MenschMachine', type: 'Organization' },
    });
    octokit.repos.listForOrg.mockResolvedValue([
      repository('MenschMachine/pdfdancer-mcp'),
    ]);

    const result = await createDashboardClient('token', octokit)
      .fetchMatchedRepositories(['MenschMachine/pdfdancer-*']);

    expect(result.repositories).toEqual([repository('MenschMachine/pdfdancer-mcp')]);
    expect(localStorage.getItem('gh-cache-repos-MenschMachine')).toBeNull();
    expect(JSON.parse(localStorage.getItem('gh-cache-repositories-v2')).version).toBe(2);
  });

  it('clears the unified repository cache through the existing cache action', () => {
    localStorage.setItem('gh-cache-repositories-v2', '{}');
    localStorage.setItem('gh-cache-runs-owner/repository', '{}');

    clearCache();

    expect(localStorage.length).toBe(0);
  });
});

describe('repository data', () => {
  function createDataOctokit() {
    const octokit = createOctokit();
    octokit.actions = {
      listWorkflowRunsForRepo: vi.fn().mockResolvedValue({
        data: {
          workflow_runs: [{
            id: 1,
            name: 'CI',
            conclusion: 'success',
            status: 'completed',
            created_at: '2026-01-01T00:00:00Z',
            html_url: 'https://github.com/runs/1',
          }],
        },
      }),
    };
    octokit.pulls = {
      list: vi.fn().mockResolvedValue({
        data: [{
          number: 7,
          title: 'Fix',
          user: { login: 'mlahr' },
          created_at: '2025-12-01T00:00:00Z',
          updated_at: '2025-12-02T00:00:00Z',
          html_url: 'https://github.com/prs/7',
          draft: false,
          labels: [],
        }],
      }),
    };
    return octokit;
  }

  it('merges runs and PRs in fetchRepositoryData and shares one cache per endpoint', async () => {
    const octokit = createDataOctokit();
    const client = createDashboardClient('token', octokit);
    const repo = repository('mlahr/upag');

    await expect(client.fetchRepositoryData(repo)).resolves.toEqual({
      name: 'mlahr/upag',
      workflow_runs: [{
        run_id: 1,
        name: 'CI',
        conclusion: 'success',
        status: 'completed',
        created_at: '2026-01-01T00:00:00Z',
        html_url: 'https://github.com/runs/1',
      }],
      open_prs: [{
        number: 7,
        title: 'Fix',
        user: 'mlahr',
        created_at: '2025-12-01T00:00:00Z',
        updated_at: '2025-12-02T00:00:00Z',
        html_url: 'https://github.com/prs/7',
        draft: false,
        labels: [],
      }],
    });

    await client.fetchRepositoryRuns(repo);
    await client.fetchRepositoryPrs(repo);

    expect(octokit.actions.listWorkflowRunsForRepo).toHaveBeenCalledTimes(1);
    expect(octokit.pulls.list).toHaveBeenCalledTimes(1);
    expect([...localStorage.values.keys()].sort()).toEqual([
      'gh-cache-prs-mlahr/upag',
      'gh-cache-runs-mlahr/upag',
    ]);
  });

  it('reads cached runs and PRs for an immediate first paint, even when stale', async () => {
    const octokit = createDataOctokit();
    const client = createDashboardClient('token', octokit);

    await client.fetchRepositoryData(repository('mlahr/upag'));

    const cached = client.getCachedRepositoryData('mlahr/upag');
    expect(cached.workflow_runs).toHaveLength(1);
    expect(cached.open_prs).toHaveLength(1);
    expect(client.getCachedRepositoryData('nobody/nothing')).toBeNull();
  });

  it('uses one cache entry for names that differ only in letter case', async () => {
    const octokit = createDataOctokit();
    const client = createDashboardClient('token', octokit);

    await client.fetchRepositoryData(repository('MLahr/UPAG'));
    await client.fetchRepositoryData(repository('mlahr/upag'));

    expect(octokit.actions.listWorkflowRunsForRepo).toHaveBeenCalledTimes(1);
    expect(octokit.pulls.list).toHaveBeenCalledTimes(1);
    expect(client.getCachedRepositoryData('MLAHR/Upag').workflow_runs).toHaveLength(1);
  });

  it('removes a bad cache entry and still returns the valid one', async () => {
    const octokit = createDataOctokit();
    const client = createDashboardClient('token', octokit);
    await client.fetchRepositoryData(repository('mlahr/upag'));
    localStorage.setItem(
      'gh-cache-runs-mlahr/upag',
      JSON.stringify({ data: { no_runs_here: true }, timestamp: Date.now() })
    );

    const cached = client.getCachedRepositoryData('mlahr/upag');

    expect(cached.workflow_runs).toBeUndefined();
    expect(cached.open_prs).toHaveLength(1);
    expect(localStorage.getItem('gh-cache-runs-mlahr/upag')).toBeNull();
  });

  it('works when the methods are used without the client object', async () => {
    const octokit = createDataOctokit();
    const { fetchRepositoryData } = createDashboardClient('token', octokit);

    const result = await fetchRepositoryData(repository('mlahr/upag'));

    expect(result.workflow_runs).toHaveLength(1);
    expect(result.open_prs).toHaveLength(1);
  });

  it('rejects the runs request for a repository that does not exist', async () => {
    const octokit = createDataOctokit();
    octokit.actions.listWorkflowRunsForRepo.mockRejectedValue(
      Object.assign(new Error('Not Found'), { status: 404 })
    );
    const client = createDashboardClient('token', octokit);

    await expect(client.fetchRepositoryRuns(repository('mlahr/missing')))
      .rejects.toMatchObject({ status: 404 });
    expect(client.getCachedRepositoryData('mlahr/missing')).toBeNull();
  });
});
