import { Octokit } from '@octokit/rest';
import picomatch from 'picomatch';

const REPOSITORY_CACHE_KEY = 'gh-cache-repositories-v2';
const REPOSITORY_CACHE_VERSION = 2;

function createEmptyRepositoryCache() {
  return { version: REPOSITORY_CACHE_VERSION, entries: {} };
}

function removeLegacyRepositoryCacheEntries() {
  const keys = [];
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key?.startsWith('gh-cache-repos-')) keys.push(key);
  }
  keys.forEach(key => localStorage.removeItem(key));
}

function readRepositoryCache() {
  removeLegacyRepositoryCacheEntries();

  try {
    const raw = localStorage.getItem(REPOSITORY_CACHE_KEY);
    if (!raw) return createEmptyRepositoryCache();

    const cache = JSON.parse(raw);
    if (
      cache?.version !== REPOSITORY_CACHE_VERSION ||
      !cache.entries ||
      typeof cache.entries !== 'object' ||
      Array.isArray(cache.entries)
    ) {
      return createEmptyRepositoryCache();
    }
    return cache;
  } catch {
    return createEmptyRepositoryCache();
  }
}

async function cachedRepositoryResolution(key, ttlMs, fetchFn) {
  const cached = readRepositoryCache().entries[key];
  if (cached && Date.now() - cached.timestamp < ttlMs) {
    return cached.data;
  }

  const data = await fetchFn();
  try {
    const cache = readRepositoryCache();
    cache.entries[key] = { data, timestamp: Date.now() };
    localStorage.setItem(REPOSITORY_CACHE_KEY, JSON.stringify(cache));
  } catch {
    // storage full — still return the data, just skip caching
  }
  return data;
}

async function cachedFetch(key, ttlMs, fetchFn) {
  try {
    const raw = localStorage.getItem(key);
    if (raw) {
      const { data, timestamp } = JSON.parse(raw);
      if (Date.now() - timestamp < ttlMs) {
        return data;
      }
    }
  } catch {
    // corrupted cache entry, ignore
  }
  const data = await fetchFn();
  try {
    localStorage.setItem(key, JSON.stringify({ data, timestamp: Date.now() }));
  } catch {
    // storage full — still return the data, just skip caching
  }
  return data;
}

// GitHub names are case-insensitive, so cache keys use the lowercase name.
// "Owner/Repo" and "owner/repo" then share one entry.
function repoCacheKey(kind, fullName) {
  return `gh-cache-${kind}-${fullName.toLowerCase()}`;
}

// Reads a cache entry without a TTL check. Removes an entry that cannot be read or mapped,
// so the same bad entry does not fail again on the next refresh.
function readStaleCacheEntry(key, mapFn) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return undefined;
    return mapFn(JSON.parse(raw).data);
  } catch {
    try {
      localStorage.removeItem(key);
    } catch {
      // storage not available — nothing more to do
    }
    return undefined;
  }
}

export function clearCache() {
  const keys = [];
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key.startsWith('gh-cache-')) keys.push(key);
  }
  keys.forEach(k => localStorage.removeItem(k));
}

export function clearRunsCache(repoFullName) {
  localStorage.removeItem(repoCacheKey('runs', repoFullName));
}

function mapRepository(repo) {
  return {
    full_name: repo.full_name,
    name: repo.name,
    owner: { login: repo.owner.login },
  };
}

function parseRepositoryPatterns(patterns) {
  const exact = [];
  const wildcardByOwner = new Map();
  const warnings = [];

  for (const pattern of patterns) {
    const firstSlash = pattern.indexOf('/');
    const hasOneSlash = firstSlash > 0 && firstSlash === pattern.lastIndexOf('/');
    if (!hasOneSlash || firstSlash === pattern.length - 1) {
      warnings.push({
        target: pattern,
        status: null,
        message: 'Expected owner/repository with exactly one slash.',
      });
      continue;
    }

    const owner = pattern.slice(0, firstSlash);
    const repositoryPattern = pattern.slice(firstSlash + 1);
    if (picomatch.scan(owner).isGlob) {
      warnings.push({
        target: pattern,
        status: null,
        message: 'The owner segment must be a literal GitHub login.',
      });
      continue;
    }

    if (!picomatch.scan(repositoryPattern).isGlob) {
      exact.push({ owner, repository: repositoryPattern, pattern });
      continue;
    }

    const ownerKey = owner.toLowerCase();
    const group = wildcardByOwner.get(ownerKey) || { owner, patterns: [] };
    group.patterns.push(pattern);
    wildcardByOwner.set(ownerKey, group);
  }

  return { exact, wildcardByOwner, warnings };
}

function warningFor(target, error) {
  return {
    target,
    status: error.status || error.response?.status || null,
    message: error.message || 'Repository resolution failed.',
  };
}

function deduplicateRepositories(repositories) {
  const byFullName = new Map();
  for (const repository of repositories) {
    byFullName.set(repository.full_name.toLowerCase(), repository);
  }
  return [...byFullName.values()];
}

function mapRuns(runsData) {
  return runsData.workflow_runs.map(run => ({
    run_id: run.id,
    name: run.name,
    conclusion: run.conclusion,
    status: run.status,
    created_at: run.created_at,
    html_url: run.html_url,
  }));
}

function mapPrs(prsData) {
  return prsData.map(pr => ({
    number: pr.number,
    title: pr.title,
    user: pr.user?.login,
    created_at: pr.created_at,
    updated_at: pr.updated_at,
    html_url: pr.html_url,
    draft: pr.draft,
    labels: pr.labels?.map(l => ({ name: l.name, color: l.color })) || [],
  }));
}

export function createDashboardClient(token, octokitOverride) {
  // GitHub answers with "cache-control: max-age=60". Without "no-cache", the browser can return
  // an old response for up to 60 seconds, even after our own cache was cleared. "no-cache" makes
  // the browser ask GitHub whether the data changed (ETag), so refresh and polling see new runs.
  const octokit = octokitOverride || new Octokit({
    auth: token,
    request: {
      fetch: (url, options) => globalThis.fetch(url, { ...options, cache: 'no-cache' }),
    },
  });

  const client = {
    async fetchMatchedRepositories(patterns, { reposTtl = 5 * 60 * 1000 } = {}) {
      const { exact, wildcardByOwner, warnings } = parseRepositoryPatterns(patterns);
      const repositories = [];

      // Exact patterns already contain the full name — resolve locally, no API call.
      // A missing repo surfaces later as an error card on its workflow-runs fetch.
      for (const item of exact) {
        repositories.push({
          full_name: `${item.owner}/${item.repository}`,
          name: item.repository,
          owner: { login: item.owner },
        });
      }

      let authenticatedInventoryPromise;
      const getAuthenticatedInventory = () => {
        if (!authenticatedInventoryPromise) {
          authenticatedInventoryPromise = cachedRepositoryResolution(
            'inventory:authenticated',
            reposTtl,
            async () => {
              const raw = await octokit.paginate(octokit.repos.listForAuthenticatedUser, {
                per_page: 100,
              });
              return raw.map(mapRepository);
            }
          );
        }
        return authenticatedInventoryPromise;
      };

      const wildcardGroups = [...wildcardByOwner.values()];
      const wildcardResults = await Promise.allSettled(wildcardGroups.map(async group => {
        const ownerKey = group.owner.toLowerCase();
        const account = await cachedRepositoryResolution(
          `owner:${ownerKey}`,
          reposTtl,
          async () => {
            const { data } = await octokit.users.getByUsername({ username: group.owner });
            return { login: data.login, type: data.type };
          }
        );
        const matcher = picomatch(group.patterns, { nocase: true });

        if (account.type === 'Organization') {
          const inventory = await cachedRepositoryResolution(
            `inventory:organization:${account.login.toLowerCase()}`,
            reposTtl,
            async () => {
              const raw = await octokit.paginate(octokit.repos.listForOrg, {
                org: account.login,
                per_page: 100,
              });
              return raw.map(mapRepository);
            }
          );
          return { repositories: inventory.filter(repo => matcher(repo.full_name)), warnings: [] };
        }

        const [publicResult, authenticatedResult] = await Promise.allSettled([
          cachedRepositoryResolution(
            `inventory:user:${account.login.toLowerCase()}`,
            reposTtl,
            async () => {
              const raw = await octokit.paginate(octokit.repos.listForUser, {
                username: account.login,
                type: 'owner',
                per_page: 100,
              });
              return raw.map(mapRepository);
            }
          ),
          getAuthenticatedInventory(),
        ]);

        const discovered = [];
        const groupWarnings = [];
        if (publicResult.status === 'fulfilled') {
          discovered.push(...publicResult.value);
        } else {
          groupWarnings.push(warningFor(`${account.login} public repositories`, publicResult.reason));
        }
        if (authenticatedResult.status === 'fulfilled') {
          discovered.push(...authenticatedResult.value.filter(repo =>
            repo.owner.login.toLowerCase() === account.login.toLowerCase()
          ));
        } else {
          groupWarnings.push(warningFor(`${account.login} accessible private repositories`, authenticatedResult.reason));
        }

        return {
          repositories: deduplicateRepositories(discovered).filter(repo => matcher(repo.full_name)),
          warnings: groupWarnings,
        };
      }));

      wildcardResults.forEach((result, index) => {
        if (result.status === 'fulfilled') {
          repositories.push(...result.value.repositories);
          warnings.push(...result.value.warnings);
        } else {
          warnings.push(warningFor(wildcardGroups[index].owner, result.reason));
        }
      });

      return { repositories: deduplicateRepositories(repositories), warnings };
    },

    async fetchRepositoryRuns(repo, { runsTtl = 2 * 60 * 1000 } = {}) {
      const runsData = await cachedFetch(repoCacheKey('runs', repo.full_name), runsTtl, async () => {
        const { data } = await octokit.actions.listWorkflowRunsForRepo({
          owner: repo.owner.login,
          repo: repo.name,
          per_page: 20,
        });
        return data;
      });

      return { name: repo.full_name, workflow_runs: mapRuns(runsData) };
    },

    async fetchRepositoryPrs(repo, { prsTtl = 2 * 60 * 1000 } = {}) {
      const prsData = await cachedFetch(repoCacheKey('prs', repo.full_name), prsTtl, async () => {
        const { data } = await octokit.pulls.list({
          owner: repo.owner.login,
          repo: repo.name,
          state: 'open',
          sort: 'updated',
          direction: 'desc',
          per_page: 10,
        });
        return data;
      });

      return { open_prs: mapPrs(prsData) };
    },

    async fetchRepositoryData(repo, options = {}) {
      const [runs, prs] = await Promise.all([
        client.fetchRepositoryRuns(repo, options),
        client.fetchRepositoryPrs(repo, options),
      ]);
      return { ...runs, ...prs };
    },

    // Synchronous read of whatever is cached (even stale) for an immediate first paint.
    getCachedRepositoryData(fullName) {
      const workflowRuns = readStaleCacheEntry(repoCacheKey('runs', fullName), mapRuns);
      const openPrs = readStaleCacheEntry(repoCacheKey('prs', fullName), mapPrs);
      if (workflowRuns === undefined && openPrs === undefined) return null;

      const cached = {};
      if (workflowRuns !== undefined) cached.workflow_runs = workflowRuns;
      if (openPrs !== undefined) cached.open_prs = openPrs;
      return cached;
    },

    async fetchPrReviews(owner, repo, pullNumber, { prsTtl = 2 * 60 * 1000 } = {}) {
      const reviews = await cachedFetch(
        `gh-cache-reviews-${owner}/${repo}#${pullNumber}`.toLowerCase(),
        prsTtl,
        async () => {
          const { data } = await octokit.pulls.listReviews({
            owner,
            repo,
            pull_number: pullNumber,
          });
          return data;
        }
      );

      // Compute status from latest review per user, ignoring COMMENTED/DISMISSED
      const latestByUser = new Map();
      for (const review of reviews) {
        const state = review.state;
        if (state === 'COMMENTED' || state === 'DISMISSED') continue;
        const user = review.user?.login;
        if (!user) continue;
        latestByUser.set(user, state);
      }

      const states = [...latestByUser.values()];
      if (states.includes('CHANGES_REQUESTED')) return 'CHANGES_REQUESTED';
      if (states.includes('APPROVED')) return 'APPROVED';
      return 'PENDING';
    },
  };

  return client;
}
