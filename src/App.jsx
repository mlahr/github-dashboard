import Dashboard from './components/Dashboard'
import './App.css'

function App() {
  const commitHash = import.meta.env.VITE_GIT_COMMIT_HASH
  const shortCommitHash = commitHash === 'unknown' ? commitHash : commitHash.slice(0, 7)

  return (
    <div className="app-shell">
      <Dashboard />
      <footer className="app-build-info">
        Commit <code title={commitHash}>{shortCommitHash}</code>
      </footer>
    </div>
  )
}

export default App
