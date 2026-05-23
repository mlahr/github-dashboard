# GitHub Actions Dashboard

A lightweight React dashboard for monitoring GitHub Actions and open pull requests across multiple repositories.

The app lets you enter one or more repository patterns, discovers matching repositories in a GitHub organization, and shows the latest workflow runs, build status history, and open PRs in one browser view.

## Features

- Monitor many repositories from a single dashboard
- Match repositories with glob patterns such as `my-org/service-*`
- Show the latest GitHub Actions workflow runs for each repository
- Highlight recent successes, failures, in-progress runs, and other states
- Show open pull requests per repository
- Group all open pull requests by label
- Fetch PR review state, including approved and changes requested
- Cache GitHub API responses in `localStorage` with configurable TTLs
- Auto-refresh repositories with active workflow runs

## Tech Stack

- React 19
- Vite 7
- Octokit REST client
- picomatch for repository glob matching
- ESLint

## Getting Started

### Prerequisites

- Node.js 20 or newer
- npm
- A GitHub personal access token

### Install

```bash
npm install
```

### Run Locally

```bash
npm run dev
```

Open the Vite URL shown in your terminal, usually:

```text
http://localhost:5173
```

On first launch, open the settings panel and enter:

- A GitHub token
- One or more repository patterns, one per line
- Optional cache TTL values in minutes

Example repository patterns:

```text
octo-org/frontend-*
octo-org/backend-api
octo-org/tools-*
```

## GitHub Token Permissions

The dashboard runs entirely in the browser and calls the GitHub API directly through Octokit.

For public repositories, a fine-grained token with read access to repository metadata, Actions, and pull requests is usually enough.

For private repositories, grant the token read access to the repositories you want to monitor. Depending on your organization settings, you may also need organization read access so the app can list repositories in the organization.

The app uses these GitHub API capabilities:

- List organization repositories
- List workflow runs for a repository
- List open pull requests
- List pull request reviews

## Configuration

Configuration is stored in the browser's `localStorage`.

| Setting | Description | Default |
| --- | --- | --- |
| GitHub token | Token used for GitHub API requests | Empty |
| Repository patterns | Glob patterns used to discover repositories | `MenschMachine/pdfdancer-client-*` |
| Repos cache TTL | How long repository discovery results are cached | 5 minutes |
| Runs cache TTL | How long workflow run results are cached | 2 minutes |
| PRs cache TTL | How long pull request and review results are cached | 2 minutes |

Use the refresh button in the dashboard to clear cached GitHub API responses and fetch fresh data.

## Repository Pattern Matching

Patterns are matched against full repository names in `owner/repo` format.

Examples:

```text
my-org/*
my-org/web-*
my-org/service-api
my-org/*-client
```

Multiple patterns can be entered on separate lines.

## Available Scripts

```bash
npm run dev
```

Start the development server.

```bash
npm run build
```

Build the production app into `dist/`.

```bash
npm run preview
```

Preview the production build locally.

```bash
npm run lint
```

Run ESLint.

## Deployment

This is a static Vite app. Build it with:

```bash
npm run build
```

Then deploy the generated `dist/` directory to any static host, such as GitHub Pages, Netlify, Vercel, Cloudflare Pages, or an internal web server.

Because the app calls GitHub directly from the browser, no backend service is required.

## Security Notes

The GitHub token is stored in browser `localStorage`. Do not use this app on shared or untrusted machines, and prefer a least-privilege token that can only read the repositories you want to monitor.

This project does not proxy or hide the token. Anyone with access to the browser profile can potentially read it.

## Example Data

The `example-data/` directory contains a sample snapshot of GitHub Actions data. The current app fetches live data from GitHub at runtime; the sample data is useful as a reference for expected API-shaped data.

## License

No license file is currently included. Add a license before publishing if you want others to use, modify, or redistribute the project.
