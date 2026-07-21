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
  it('resolves and caches an exact user-owned repository', async () => {
    const octokit = createOctokit();
    octokit.repos.get.mockResolvedValue({ data: repository('mlahr/upag') });
    const client = createDashboardClient('token', octokit);

    const first = await client.fetchMatchedRepositories(['mlahr/upag']);
    const second = await client.fetchMatchedRepositories(['mlahr/upag']);

    expect(first).toEqual({
      repositories: [repository('mlahr/upag')],
      warnings: [],
    });
    expect(second).toEqual(first);
    expect(octokit.repos.get).toHaveBeenCalledTimes(1);
    expect([...localStorage.values.keys()]).toEqual(['gh-cache-repositories-v2']);
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

  it('returns valid repositories with a targeted warning for a failed pattern', async () => {
    const octokit = createOctokit();
    const notFound = Object.assign(new Error('Not Found'), { status: 404 });
    octokit.repos.get.mockRejectedValue(notFound);
    octokit.users.getByUsername.mockResolvedValue({
      data: { login: 'MenschMachine', type: 'Organization' },
    });
    octokit.repos.listForOrg.mockResolvedValue([
      repository('MenschMachine/pdfdancer-mcp'),
    ]);

    const result = await createDashboardClient('token', octokit)
      .fetchMatchedRepositories(['mlahr/missing', 'MenschMachine/pdfdancer-*']);

    expect(result.repositories).toEqual([repository('MenschMachine/pdfdancer-mcp')]);
    expect(result.warnings).toEqual([{
      target: 'mlahr/missing',
      status: 404,
      message: 'Not Found',
    }]);
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
    octokit.repos.get.mockImplementation(({ owner, repo }) =>
      Promise.resolve({ data: repository(`${owner}/${repo}`) })
    );
    const client = createDashboardClient('token', octokit);

    await client.fetchMatchedRepositories(['mlahr/upag']);
    await client.fetchMatchedRepositories(['octocat/Hello-World']);

    const cache = JSON.parse(localStorage.getItem('gh-cache-repositories-v2'));
    expect(Object.keys(cache.entries).sort()).toEqual([
      'repository:mlahr/upag',
      'repository:octocat/hello-world',
    ]);
  });

  it('refreshes only stale resolutions', async () => {
    const octokit = createOctokit();
    octokit.repos.get.mockImplementation(({ owner, repo }) =>
      Promise.resolve({ data: repository(`${owner}/${repo}`) })
    );
    const client = createDashboardClient('token', octokit);

    await client.fetchMatchedRepositories(['mlahr/upag', 'octocat/Hello-World']);
    const cache = JSON.parse(localStorage.getItem('gh-cache-repositories-v2'));
    cache.entries['repository:mlahr/upag'].timestamp = 0;
    localStorage.setItem('gh-cache-repositories-v2', JSON.stringify(cache));

    await client.fetchMatchedRepositories(
      ['mlahr/upag', 'octocat/Hello-World'],
      { reposTtl: 60_000 }
    );

    expect(octokit.repos.get).toHaveBeenCalledTimes(3);
    expect(octokit.repos.get).toHaveBeenCalledWith({ owner: 'mlahr', repo: 'upag' });
  });

  it('ignores corrupted cache data and removes legacy repository entries', async () => {
    localStorage.setItem('gh-cache-repositories-v2', '{bad json');
    localStorage.setItem('gh-cache-repos-MenschMachine', '{}');
    const octokit = createOctokit();
    octokit.repos.get.mockResolvedValue({ data: repository('mlahr/upag') });

    await createDashboardClient('token', octokit).fetchMatchedRepositories(['mlahr/upag']);

    expect(octokit.repos.get).toHaveBeenCalledTimes(1);
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
