import { useEffect, useRef, useState } from 'react';
import { clearCache, clearRunsCache, createDashboardClient } from '../github.js';
import StatsBar from './StatsBar';
import RepositoryCard from './RepositoryCard';
import AllPrsSection from './AllPrsSection';
import './Dashboard.css';

const LS_TOKEN_KEY = 'gh-dashboard-token';
const LS_PATTERNS_KEY = 'gh-dashboard-patterns';
const LS_REPOS_TTL_KEY = 'gh-dashboard-repos-ttl';
const LS_RUNS_TTL_KEY = 'gh-dashboard-runs-ttl';
const LS_PRS_TTL_KEY = 'gh-dashboard-prs-ttl';
const DEFAULT_PATTERNS = '';
const DEFAULT_REPOS_TTL = 5;
const DEFAULT_RUNS_TTL = 2;
const DEFAULT_PRS_TTL = 2;

function getErrorMessage(err) {
  const status = err.status || err.response?.status;

  if (status === 401) {
    return 'Bad credentials — check your GitHub token.';
  }
  if (status === 403) {
    return 'Access denied — your token may lack the required scopes.';
  }
  if (status === 404) {
    return 'Not found — check your repository patterns and org names.';
  }

  return err.message;
}

function getLatestWorkflowRun(repo) {
  if (!repo.workflow_runs || repo.workflow_runs.length === 0) {
    return null;
  }

  return repo.workflow_runs.reduce((latestRun, run) => {
    const timestamp = Date.parse(run.created_at);
    const latestTimestamp = latestRun ? Date.parse(latestRun.created_at) : null;

    if (Number.isNaN(timestamp)) {
      return latestRun;
    }

    if (latestTimestamp === null || Number.isNaN(latestTimestamp) || timestamp > latestTimestamp) {
      return run;
    }

    return latestRun;
  }, null);
}

function getRepositoryStatusCounts(repositories) {
  let success = 0;
  let failed = 0;
  let other = 0;
  let openPrs = 0;

  repositories.forEach(repo => {
    const hasData = repo.workflow_runs.length > 0 || repo.open_prs.length > 0;

    if ((repo.loading || repo.error) && !hasData) return;

    openPrs += repo.open_prs.length;

    const latestRun = getLatestWorkflowRun(repo);
    if (!latestRun) return;

    if (latestRun.conclusion === 'success') success++;
    else if (latestRun.conclusion === 'failure') failed++;
    else other++;
  });

  return { success, failed, other, openPrs };
}

function getLatestRunTimestamp(repo) {
  const latestRun = getLatestWorkflowRun(repo);
  if (!latestRun) return null;

  const timestamp = Date.parse(latestRun.created_at);
  return Number.isNaN(timestamp) ? null : timestamp;
}

function compareRepositoriesByLatestRun(a, b) {
  const aLatest = getLatestRunTimestamp(a);
  const bLatest = getLatestRunTimestamp(b);

  if (aLatest !== null && bLatest !== null && aLatest !== bLatest) {
    return bLatest - aLatest;
  }

  if (aLatest !== null) return -1;
  if (bLatest !== null) return 1;

  return a.name.localeCompare(b.name);
}

const AUTO_POLL_INTERVAL = 15_000;

function hasActiveRuns(repo) {
  return repo.workflow_runs.some(run => run.status !== 'completed');
}

function createPlaceholderRepository(name) {
  return {
    name,
    workflow_runs: [],
    open_prs: [],
    loading: true,
    refreshing: false,
    error: null,
  };
}

function mergeRepositoriesWithMatches(previousRepositories, matchedRepos) {
  const previousByName = new Map(previousRepositories.map(repo => [repo.name, repo]));

  return matchedRepos.map(repo => {
    const previous = previousByName.get(repo.full_name);

    if (!previous) {
      return createPlaceholderRepository(repo.full_name);
    }

    const hasExistingData = previous.workflow_runs.length > 0 || previous.open_prs.length > 0;

    return {
      ...previous,
      loading: !hasExistingData,
      refreshing: hasExistingData,
      error: null,
    };
  });
}

export default function Dashboard() {
  const [repositories, setRepositories] = useState([]);
  const [matchedRepoCount, setMatchedRepoCount] = useState(0);
  const [discovering, setDiscovering] = useState(() => !!localStorage.getItem(LS_TOKEN_KEY));
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState(null);
  const [settingsOpen, setSettingsOpen] = useState(false);

  const [token, setToken] = useState(() => localStorage.getItem(LS_TOKEN_KEY) || '');
  const [repoPatterns, setRepoPatterns] = useState(() =>
    localStorage.getItem(LS_PATTERNS_KEY) || DEFAULT_PATTERNS
  );

  const [reposTtl, setReposTtl] = useState(() =>
    Number(localStorage.getItem(LS_REPOS_TTL_KEY)) || DEFAULT_REPOS_TTL
  );
  const [runsTtl, setRunsTtl] = useState(() =>
    Number(localStorage.getItem(LS_RUNS_TTL_KEY)) || DEFAULT_RUNS_TTL
  );
  const [prsTtl, setPrsTtl] = useState(() =>
    Number(localStorage.getItem(LS_PRS_TTL_KEY)) || DEFAULT_PRS_TTL
  );

  const [draftToken, setDraftToken] = useState(token);
  const [draftPatterns, setDraftPatterns] = useState(repoPatterns);
  const [draftReposTtl, setDraftReposTtl] = useState(reposTtl);
  const [draftRunsTtl, setDraftRunsTtl] = useState(runsTtl);
  const [draftPrsTtl, setDraftPrsTtl] = useState(prsTtl);
  const [refreshCounter, setRefreshCounter] = useState(0);
  const repositoriesRef = useRef(repositories);
  const matchedRepoCountRef = useRef(matchedRepoCount);

  useEffect(() => {
    repositoriesRef.current = repositories;
  }, [repositories]);

  useEffect(() => {
    matchedRepoCountRef.current = matchedRepoCount;
  }, [matchedRepoCount]);

  useEffect(() => {
    if (!token) return;

    let cancelled = false;
    const hasExistingResults =
      repositoriesRef.current.length > 0 || matchedRepoCountRef.current > 0;

    const patterns = repoPatterns
      .split('\n')
      .map(p => p.trim())
      .filter(Boolean);

    const client = createDashboardClient(token);
    const ttlOptions = {
      reposTtl: reposTtl * 60 * 1000,
      runsTtl: runsTtl * 60 * 1000,
      prsTtl: prsTtl * 60 * 1000,
    };

    setError(null);
    setDiscovering(!hasExistingResults);
    setRefreshing(hasExistingResults);

    client.fetchMatchedRepositories(patterns, ttlOptions)
      .then(matchedRepos => {
        if (cancelled) return;

        setMatchedRepoCount(matchedRepos.length);
        setRepositories(prev => mergeRepositoriesWithMatches(prev, matchedRepos));
        setDiscovering(false);

        if (matchedRepos.length === 0) {
          setRefreshing(false);
          return;
        }

        Promise.allSettled(
          matchedRepos.map(async repo => {
            try {
              const result = await client.fetchRepositoryData(repo, ttlOptions);

              if (cancelled) return;

              setRepositories(prev => prev.map(current =>
                current.name === repo.full_name
                  ? {
                      ...current,
                      ...result,
                      loading: false,
                      refreshing: false,
                      error: null,
                    }
                  : current
              ));
            } catch (err) {
              if (cancelled) return;

              setRepositories(prev => prev.map(current =>
                current.name === repo.full_name
                  ? {
                      ...current,
                      loading: false,
                      refreshing: false,
                      error: getErrorMessage(err),
                    }
                  : current
              ));
            }
          })
        ).finally(() => {
          if (!cancelled) {
            setRefreshing(false);
          }
        });
      })
      .catch(err => {
        if (!cancelled) {
          setError(getErrorMessage(err));
          setSettingsOpen(true);
          setDiscovering(false);
          setRefreshing(false);
        }
      });

    return () => { cancelled = true; };
  }, [token, repoPatterns, reposTtl, runsTtl, prsTtl, refreshCounter]);

  useEffect(() => {
    if (!token) return;

    const intervalId = setInterval(() => {
      const activeRepos = repositoriesRef.current.filter(
        repo => !repo.loading && !repo.refreshing && hasActiveRuns(repo)
      );

      if (activeRepos.length === 0) return;

      const client = createDashboardClient(token);
      const ttlOptions = {
        runsTtl: runsTtl * 60 * 1000,
        prsTtl: prsTtl * 60 * 1000,
      };

      for (const repo of activeRepos) {
        const [owner, repoName] = repo.name.split('/');
        clearRunsCache(repo.name);

        client.fetchRepositoryData(
          { full_name: repo.name, name: repoName, owner: { login: owner } },
          ttlOptions
        ).then(result => {
          setRepositories(prev => prev.map(current =>
            current.name === repo.name
              ? { ...current, ...result, loading: false, refreshing: false, error: null }
              : current
          ));
        }).catch(() => {
          // silently ignore polling errors
        });
      }
    }, AUTO_POLL_INTERVAL);

    return () => clearInterval(intervalId);
  }, [token, runsTtl, prsTtl]);

  function handleSave() {
    localStorage.setItem(LS_TOKEN_KEY, draftToken);
    localStorage.setItem(LS_PATTERNS_KEY, draftPatterns);
    localStorage.setItem(LS_REPOS_TTL_KEY, draftReposTtl);
    localStorage.setItem(LS_RUNS_TTL_KEY, draftRunsTtl);
    localStorage.setItem(LS_PRS_TTL_KEY, draftPrsTtl);
    setError(null);
    if (!draftToken) {
      setRepositories([]);
      setMatchedRepoCount(0);
      setDiscovering(false);
      setRefreshing(false);
    }
    setToken(draftToken);
    setRepoPatterns(draftPatterns);
    setReposTtl(draftReposTtl);
    setRunsTtl(draftRunsTtl);
    setPrsTtl(draftPrsTtl);
    setSettingsOpen(false);
  }

  function handleRefresh() {
    clearCache();
    setError(null);
    setRefreshCounter(c => c + 1);
  }

  const settingsPanel = (
    <div className="settings-panel elevated-section">
      <div className="settings-field">
        <label htmlFor="gh-token">GitHub Token</label>
        <input
          id="gh-token"
          type="password"
          value={draftToken}
          onChange={e => setDraftToken(e.target.value)}
          placeholder="ghp_..."
        />
      </div>
      <div className="settings-field">
        <label htmlFor="repo-patterns">Repository Patterns (one per line)</label>
        <textarea
          id="repo-patterns"
          value={draftPatterns}
          onChange={e => setDraftPatterns(e.target.value)}
          rows={4}
          placeholder="org/repo-*"
        />
      </div>
      <div className="settings-field-row">
        <div className="settings-field">
          <label htmlFor="repos-ttl">Repos Cache TTL (min)</label>
          <input
            id="repos-ttl"
            type="number"
            min="0"
            value={draftReposTtl}
            onChange={e => setDraftReposTtl(Number(e.target.value))}
          />
        </div>
        <div className="settings-field">
          <label htmlFor="runs-ttl">Runs Cache TTL (min)</label>
          <input
            id="runs-ttl"
            type="number"
            min="0"
            value={draftRunsTtl}
            onChange={e => setDraftRunsTtl(Number(e.target.value))}
          />
        </div>
        <div className="settings-field">
          <label htmlFor="prs-ttl">PRs Cache TTL (min)</label>
          <input
            id="prs-ttl"
            type="number"
            min="0"
            value={draftPrsTtl}
            onChange={e => setDraftPrsTtl(Number(e.target.value))}
          />
        </div>
      </div>
      <button className="settings-save" onClick={handleSave}>Save</button>
    </div>
  );

  const headerRow = (
    <div className="dashboard-header-row">
      <h1 className="dashboard-title">GitHub Actions Dashboard</h1>
      <div className="header-buttons">
        <button
          className="settings-toggle"
          onClick={handleRefresh}
          aria-label="Refresh"
          title={refreshing || discovering ? 'Refreshing' : 'Clear cache and refresh'}
        >
          <span className={refreshing || discovering ? 'refresh-icon-spinning' : ''}>&#8635;</span>
        </button>
        <button
          className="settings-toggle"
          onClick={() => setSettingsOpen(!settingsOpen)}
          aria-label="Settings"
        >
          &#9881;
        </button>
      </div>
    </div>
  );

  const hasRenderedResults = matchedRepoCount > 0 || repositories.length > 0;

  if (!token) {
    return (
      <div className="dashboard">
        <section className="dashboard-hero elevated-section">
          {headerRow}
          <div className="loading">Please configure your GitHub token.</div>
        </section>
        {settingsOpen && settingsPanel}
      </div>
    );
  }

  if (error && !hasRenderedResults) {
    return (
      <div className="dashboard">
        <section className="dashboard-hero elevated-section">
          {headerRow}
          <div className="error">Error: {error}</div>
        </section>
        {settingsOpen && settingsPanel}
      </div>
    );
  }

  if (discovering && !hasRenderedResults) {
    return (
      <div className="dashboard">
        <section className="dashboard-hero elevated-section">
          {headerRow}
          <div className="loading">Discovering repositories...</div>
        </section>
        {settingsOpen && settingsPanel}
      </div>
    );
  }

  const loadedRepoCount = repositories.filter(repo => !repo.loading).length;
  const hasBackgroundLoading = loadedRepoCount < matchedRepoCount;
  const refreshingRepoCount = repositories.filter(repo => repo.loading || repo.refreshing).length;
  const { failed, other } = getRepositoryStatusCounts(repositories);
  const sortedRepositories = [...repositories].sort(compareRepositoriesByLatestRun);

  return (
    <div className="dashboard">
      <section className="dashboard-hero elevated-section">
        {headerRow}
        {error && (
          <div className="error dashboard-inline-error">Error: {error}</div>
        )}
        <div className="dashboard-hero-stats">
          <StatsBar failed={failed} other={other} />
          <span className={`dashboard-meta${refreshing ? ' dashboard-meta-refreshing' : ''}`}>
            {matchedRepoCount === 0
              ? refreshing
                ? 'Refreshing...'
                : 'No matches.'
              : hasBackgroundLoading
                ? `${loadedRepoCount}/${matchedRepoCount} loaded`
                : refreshing
                  ? `Refreshing ${refreshingRepoCount}/${matchedRepoCount}`
                : `${matchedRepoCount} repos`}
          </span>
        </div>
      </section>

      {settingsOpen && settingsPanel}

      <AllPrsSection repositories={repositories} token={token} prsTtl={prsTtl} />

      <section className="dashboard-section elevated-section repositories-section">
        {matchedRepoCount === 0 ? (
          <div className="loading">No repositories matched the configured patterns.</div>
        ) : (
          <div className="repositories">
            {sortedRepositories.map(repo => (
              <RepositoryCard
                key={repo.name}
                repoName={repo.name}
                runs={repo.workflow_runs}
                prs={repo.open_prs}
                loading={repo.loading}
                refreshing={repo.refreshing}
                error={repo.error}
              />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
