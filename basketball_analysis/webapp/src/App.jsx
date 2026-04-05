import { useState, useEffect, useRef, useCallback } from 'react'
import './index.css'

const API = ''

function formatEventFrame(event) {
  return event.frame ?? event.start_frame ?? event.end_frame ?? null
}

function eventIcon(type) {
  if (type === 'PASS') return '🏀'
  if (type === 'INTERCEPTION') return '🔴'
  if (type === 'SHOT') return '🎯'
  if (type === 'TURNOVER') return '↔'
  return '⚡'
}

function eventText(event) {
  const type = String(event.type || 'EVENT').replaceAll('_', ' ')
  const team = event.team ? ` — Team ${event.team}` : ''
  const players = event.from_player || event.to_player
    ? ` <span class="intel-detail">${event.from_player ? `#${event.from_player}` : ''}${event.from_player && event.to_player ? ' → ' : ''}${event.to_player ? `#${event.to_player}` : ''}</span>`
    : ''
  const confidence = event.confidence ? ` <span class="intel-confidence">${event.confidence}</span>` : ''
  return `<span class="highlight">${type}</span>${team}${players}${confidence}`
}

function buildPipelineEvents(frames = []) {
  const evts = []
  frames.forEach((f) => {
    ;(f.events || []).forEach(ev => {
      if (ev === 'PASS_TEAM1') evts.push({ frame: f.frame_number, icon: '🏀', text: '<span class="highlight">Pass</span> — Team 1' })
      if (ev === 'PASS_TEAM2') evts.push({ frame: f.frame_number, icon: '🏀', text: '<span class="highlight">Pass</span> — Team 2' })
      if (ev === 'INTERCEPTION_TEAM1') evts.push({ frame: f.frame_number, icon: '🔴', text: '<span class="highlight">Interception</span> — Team 1' })
      if (ev === 'INTERCEPTION_TEAM2') evts.push({ frame: f.frame_number, icon: '🔴', text: '<span class="highlight">Interception</span> — Team 2' })
    })
  })
  return evts
}

function buildExpertEvents(correctedAnalytics) {
  const criticalTypes = new Set(['PASS', 'INTERCEPTION', 'SHOT'])
  return (correctedAnalytics?.events || [])
    .filter(event => criticalTypes.has(event.type))
    .map(event => ({
      frame: formatEventFrame(event),
      icon: eventIcon(event.type),
      text: eventText(event),
      source: 'gemini',
    }))
    .sort((a, b) => a.frame - b.frame)
}

function clampScore(value) {
  return Math.max(0, Math.min(100, Math.round(value)))
}

function stableScore(value) {
  return Math.max(0, Math.min(100, Math.round(value / 5) * 5))
}

function countMatches(text, terms) {
  const lower = text.toLowerCase()
  return terms.reduce((total, term) => total + (lower.includes(term) ? 1 : 0), 0)
}

function metricShare(value, otherValue) {
  const total = value + otherValue
  if (total <= 0) return 0.5
  return value / total
}

function textModifier(teamText, positiveTerms, negativeTerms, maxSwing = 8) {
  const positive = countMatches(teamText, positiveTerms)
  const negative = countMatches(teamText, negativeTerms)
  return Math.max(-maxSwing, Math.min(maxSwing, (positive - negative) * 3))
}

function extractTeamText(reportText, teamNumber) {
  const text = reportText || ''
  const patterns = [
    new RegExp(`team\\s*${teamNumber}[^.\\n]*(?:\\.|$)`, 'gi'),
    new RegExp(`t${teamNumber}[^.\\n]*(?:\\.|$)`, 'gi'),
  ]
  return patterns.flatMap(pattern => text.match(pattern) || []).join(' ')
}

function extractRecommendations(reportText, teamNumber) {
  const lines = String(reportText || '').split(/\n|(?=Team\s+\d:)/i)
  return lines
    .map(line => line.replace(/^[-*\s]+/, '').trim())
    .filter(line => new RegExp(`team\\s*${teamNumber}`, 'i').test(line))
    .filter(line => /should|focus|improve|maintain|close|reduce|increase|disrupt|recommend/i.test(line))
    .slice(0, 3)
}

function buildPossessionFlow(reportText, correctedAnalytics) {
  const text = reportText || ''
  const arrowMatch = text.match(/((?:#\d+\s*(?:->|→)\s*)+#\d+)/)
  if (arrowMatch) {
    return arrowMatch[1].split(/\s*(?:->|→)\s*/).map((player, index) => ({
      label: player.trim(),
      detail: index === 0 ? 'Start' : index === arrowMatch[1].split(/\s*(?:->|→)\s*/).length - 1 ? 'Finish' : 'Pass',
    }))
  }

  const events = (correctedAnalytics?.events || [])
    .filter(event => ['PASS', 'SHOT'].includes(event.type))
    .slice(0, 5)

  if (events.length > 0) {
    const nodes = []
    events.forEach(event => {
      if (event.from_player) nodes.push(`#${event.from_player}`)
      if (event.to_player) nodes.push(`#${event.to_player}`)
      if (event.type === 'SHOT' && !event.to_player) nodes.push('Shot')
    })
    return [...new Set(nodes)].map((label, index) => ({
      label,
      detail: index === 0 ? 'Start' : label === 'Shot' ? 'Attempt' : 'Action',
    }))
  }

  const shotTeam = /team\s*1[^.]*shot/i.test(text) ? 1 : /team\s*2[^.]*shot/i.test(text) ? 2 : null
  return shotTeam ? [
    { label: `Team ${shotTeam}`, detail: 'Possession' },
    { label: 'Shot', detail: 'Attempt' },
  ] : []
}

function buildGeminiVisualization(reportText = '', correctedAnalytics = {}) {
  const fullText = reportText.toLowerCase()
  const teamTexts = {
    1: extractTeamText(reportText, 1).toLowerCase(),
    2: extractTeamText(reportText, 2).toLowerCase(),
  }

  const categories = [
    {
      key: 'offense',
      label: 'Offense',
      positive: ['successful offensive', 'shooting', 'shot', 'open shot', 'high-percentage', 'attacking', 'field goal'],
      negative: ['no shot', 'bad shot', 'forced shot', 'poor shot'],
    },
    {
      key: 'ballControl',
      label: 'Ball Control',
      lineLabel: ['Ball', 'Control'],
      positive: ['100% control', 'maintained', 'clean pass', 'successful pass', 'ball movement', 'fluid', 'possession'],
      negative: ['turnover', 'lost possession', 'interception', 'poor control'],
    },
    {
      key: 'defense',
      label: 'Defense',
      positive: ['defensive posture', 'pressure', 'interference', 'disrupt', 'closing', 'prevent'],
      negative: ['no defensive interference', 'improve defensive pressure', 'weak defensive', 'passing lanes'],
    },
    {
      key: 'tactics',
      label: 'Tactics',
      positive: ['tactics', 'spacing', 'perimeter', 'draw the defense', 'rhythm', 'transition', 'execution'],
      negative: ['poor spacing', 'slow transition', 'did not adapt'],
    },
    {
      key: 'discipline',
      label: 'Mistake Control',
      lineLabel: ['Mistake', 'Control'],
      positive: ['no significant', 'no interceptions', 'no defensive interference', 'clean', 'no mistakes'],
      negative: ['mistake', 'correction', 'foul', 'turnover', 'error', 'interception'],
    },
  ]

  const metrics = {
    1: {
      passes: Number(correctedAnalytics.team1_passes) || 0,
      shots: Number(correctedAnalytics.team1_shots) || 0,
      possession: Number(correctedAnalytics.team1_ball_control_pct) || 0,
      interceptions: Number(correctedAnalytics.team1_interceptions) || 0,
    },
    2: {
      passes: Number(correctedAnalytics.team2_passes) || 0,
      shots: Number(correctedAnalytics.team2_shots) || 0,
      possession: Number(correctedAnalytics.team2_ball_control_pct) || 0,
      interceptions: Number(correctedAnalytics.team2_interceptions) || 0,
    },
  }

  const teams = [1, 2].map(team => {
    const teamText = teamTexts[team]
    const otherText = teamTexts[team === 1 ? 2 : 1]
    const hasEvidence = teamText.length > 0 || metrics[team].passes || metrics[team].shots || metrics[team].possession

    const otherMetrics = metrics[team === 1 ? 2 : 1]
    const passShare = metricShare(metrics[team].passes, otherMetrics.passes)
    const shotShare = metricShare(metrics[team].shots, otherMetrics.shots)
    const possessionScore = metrics[team].possession || (passShare * 100)
    const activeTeamBoost = metrics[team].passes > 0 || metrics[team].shots > 0 || metrics[team].possession > 0 ? 1 : 0

    const scores = categories.reduce((acc, category) => {
      let score = 50

      if (category.key === 'offense') {
        score = 38 + shotShare * 34 + passShare * 18 + Math.min(metrics[team].shots, 3) * 4
      }
      if (category.key === 'ballControl') {
        score = 32 + possessionScore * 0.48 + passShare * 16 + Math.min(metrics[team].passes, 5) * 2
      }
      if (category.key === 'defense') {
        const opponentActivity = otherMetrics.passes + otherMetrics.shots
        score = 50 + metrics[team].interceptions * 10 - Math.min(opponentActivity, 5) * 2
        if (teamText.includes('defensive posture')) score += 5
      }
      if (category.key === 'tactics') {
        score = 42 + passShare * 18 + shotShare * 14 + activeTeamBoost * 8
      }
      if (category.key === 'discipline') {
        score = 70 - metrics[team].interceptions * 4
        if (/turnover|foul|error/i.test(teamText)) score -= 8
        if (/no significant|no mistakes|clean|no interceptions/i.test(fullText)) score += 5
      }

      if (!hasEvidence && otherText.length > 0) score = Math.min(score, 45)
      score += textModifier(teamText, category.positive, category.negative)
      acc[category.key] = stableScore(score)
      return acc
    }, {})

    const overall = stableScore(
      scores.offense * 0.25 +
      scores.ballControl * 0.2 +
      scores.defense * 0.2 +
      scores.tactics * 0.2 +
      scores.discipline * 0.15
    )

    const recommendations = extractRecommendations(reportText, team)
    const risks = [
      {
        label: 'Defensive pressure',
        value: clampScore(100 - scores.defense + (/pressure|passing lane|close/i.test(teamText) ? 18 : 0)),
      },
      {
        label: 'Ball security',
        value: clampScore(100 - scores.ballControl + (/turnover|interception|lost/i.test(teamText) ? 18 : 0)),
      },
      {
        label: 'Shot creation',
        value: clampScore(100 - scores.offense + (metrics[team].shots === 0 ? 16 : 0)),
      },
      {
        label: 'Spacing rhythm',
        value: clampScore(100 - scores.tactics + (/spacing|rhythm/i.test(teamText) ? 8 : 0)),
      },
    ].sort((a, b) => b.value - a.value)

    return {
      id: team,
      name: `Team ${team}`,
      scores,
      overall,
      confidence: hasEvidence ? (teamText.length > 80 ? 'Medium' : 'Low') : 'Low',
      recommendations,
      risks,
    }
  })

  return {
    categories,
    teams,
    flow: buildPossessionFlow(reportText, correctedAnalytics),
    tags: [
      { label: 'Successful possession', description: 'Advanced analytics saw a team complete the possession with useful control or outcome.', pattern: /successful offensive|successful possession/i },
      { label: 'Clean pass', description: 'A pass connected clearly without a turnover or defensive disruption.', pattern: /clean pass|successful pass/i },
      { label: 'Open shot chance', description: 'The offense created enough space for a higher-quality shot attempt.', pattern: /open shot|high-percentage|field goal/i },
      { label: 'Defensive shape held', description: 'A team stayed organized defensively, even if it did not win the ball.', pattern: /defensive posture/i },
      { label: 'Pressure issue', description: 'Advanced analytics recommended stronger pressure or better passing-lane denial.', pattern: /improve defensive pressure|passing lanes|close/i },
      { label: 'No major errors', description: 'Advanced analytics did not detect a serious mistake in the analyzed segment.', pattern: /no significant|no mistakes|no interceptions/i },
      { label: 'Spacing action', description: 'Player spacing or perimeter positioning affected the possession.', pattern: /spacing|perimeter/i },
    ].filter(tag => tag.pattern.test(reportText)),
  }
}

async function readJsonResponse(res) {
  const text = await res.text()
  if (!text) return {}
  try {
    return JSON.parse(text)
  } catch {
    throw new Error(`Server returned an invalid response (${res.status})`)
  }
}

function Header({ status, currentFrame, totalFrames, elapsed, appState, canOpenDashboard, canOpenExpert, onNavigate }) {
  const statusClass = status === 'complete' ? 'active' : status === 'running' ? 'processing' : 'idle'
  const statusText = status === 'complete' ? 'ANALYSIS READY' : status === 'running' ? 'PROCESSING' : 'AWAITING INPUT'

  return (
    <div className="header">
      <div className="header-title">
        <span className="logo">🏀</span>
        <h1>BASKETBALL COMMAND</h1>
        <span className="subtitle">TACTICAL INTELLIGENCE</span>
      </div>
      <div className="header-right">
        <nav className="page-nav" aria-label="Page navigation">
          <button className={appState === 'home' ? 'active' : ''} onClick={() => onNavigate?.('home')}>
            HOME
          </button>
          <button className={appState === 'upload' ? 'active' : ''} onClick={() => onNavigate?.('upload')}>
            UPLOAD
          </button>
          <button className={appState === 'dashboard' ? 'active' : ''} onClick={() => onNavigate?.('dashboard')} disabled={!canOpenDashboard}>
            DASHBOARD
          </button>
          <button className={appState === 'expert' ? 'active' : ''} onClick={() => onNavigate?.('expert')} disabled={!canOpenExpert}>ADVANCED</button>
        </nav>
        <div>
          <span className={`status-dot ${statusClass}`}></span>
          <span style={{ color: statusClass === 'active' ? 'var(--accent)' : statusClass === 'processing' ? 'var(--accent-yellow)' : 'var(--text-dim)' }}>
            {statusText}
          </span>
        </div>
        {totalFrames > 0 && (
          <div className="frame-counter">
            FRM <span>{String(currentFrame).padStart(4, '0')}</span> / {String(totalFrames).padStart(4, '0')}
          </div>
        )}
        {elapsed && <div style={{ color: 'var(--text-dim)' }}>{elapsed}</div>}
      </div>
    </div>
  )
}

function HomeScreen({ onStart, canOpenDashboard, onOpenDashboard }) {
  return (
    <main className="home-screen">
      <section className="home-hero" aria-labelledby="home-title">
        <div className="home-copy">
          <p className="home-kicker">Basketball Video Analysis</p>
          <h2 id="home-title">Turn game footage into tactical insight.</h2>
          <p className="home-summary">
            Upload a basketball clip, run player and ball tracking, then review possession,
            passes, interceptions, speed, and tactical positioning from one dashboard.
          </p>
          <div className="home-actions">
            <button className="home-primary-btn" onClick={onStart}>
              START ANALYSIS
            </button>
            {canOpenDashboard && (
              <button className="home-secondary-btn" onClick={onOpenDashboard}>
                OPEN LAST DASHBOARD
              </button>
            )}
          </div>
        </div>

        <div className="home-snapshot" aria-hidden="true">
          <div className="court-lines">
            <span className="court-half" />
            <span className="court-circle" />
            <span className="court-key left" />
            <span className="court-key right" />
          </div>
          <div className="tracking-chip player-a">P12</div>
          <div className="tracking-chip player-b">P70</div>
          <div className="tracking-chip player-c">P16</div>
          <div className="tracking-ball" />
          <div className="snapshot-label">LIVE TACTICAL MAP</div>
        </div>
      </section>

      <section className="home-strip" aria-label="System capabilities">
        <div>
          <span>01</span>
          <strong>Detect</strong>
          <p>Players, ball, and court keypoints.</p>
        </div>
        <div>
          <span>02</span>
          <strong>Track</strong>
          <p>Possession, teams, speed, and distance.</p>
        </div>
        <div>
          <span>03</span>
          <strong>Review</strong>
          <p>Annotated video, tactical radar, and event feed.</p>
        </div>
      </section>
    </main>
  )
}

function StatsBar({ stats }) {
  const cards = [
    { label: 'T1 PASSES', value: stats.team1_passes, dot: 'var(--team1-color)' },
    { label: 'T2 PASSES', value: stats.team2_passes, dot: 'var(--team2-color)' },
    { label: 'T1 INTCPT', value: stats.team1_interceptions, dot: 'var(--team1-color)' },
    { label: 'T2 INTCPT', value: stats.team2_interceptions, dot: 'var(--team2-color)' },
    { label: 'T1 SHOTS', value: stats.team1_shots, dot: 'var(--team1-color)' },
    { label: 'T2 SHOTS', value: stats.team2_shots, dot: 'var(--team2-color)' },
    { label: 'MAX SPEED', value: stats.maxSpeed, unit: 'km/h' },
    { label: 'PLAYERS', value: stats.totalPlayers },
    { label: 'T1 POSS.', value: stats.team1_ball_control_pct, unit: '%' },
    { label: 'T2 POSS.', value: stats.team2_ball_control_pct, unit: '%' },
  ]

  return (
    <div className="stats-bar">
      {cards.map((c, i) => (
        <div key={i} className="stat-card">
          <div className="label">
            {c.dot && <span className="dot" style={{ background: c.dot }}></span>}
            {c.label}
          </div>
          <div className="value">
            {typeof c.value === 'number' ? (c.unit === '%' || c.unit === 'km/h' ? c.value.toFixed(1) : c.value) : '—'}
            {c.unit && <span className="unit">{c.unit}</span>}
          </div>
        </div>
      ))}
    </div>
  )
}

function VideoUpload({ onUpload, onLoadExisting }) {
  const [dragActive, setDragActive] = useState(false)
  const [uploadInfo, setUploadInfo] = useState(null)
  const [uploading, setUploading] = useState(false)
  const [previousJobs, setPreviousJobs] = useState([])
  const inputRef = useRef(null)

  useEffect(() => {
    fetch(`${API}/api/jobs`)
      .then(readJsonResponse)
      .then(data => {
        const complete = data.filter(j => j.status === 'complete').sort((a,b) => b.completed_at.localeCompare(a.completed_at));
        setPreviousJobs(complete);
      })
      .catch(err => console.error("Could not fetch jobs", err));
  }, []);

  const handleDrop = useCallback(async (e) => {
    e.preventDefault()
    setDragActive(false)
    const file = e.dataTransfer.files[0]
    if (file) await doUpload(file)
  }, [])

  const handleFileSelect = async (e) => {
    const file = e.target.files[0]
    if (file) await doUpload(file)
  }

  const doUpload = async (file) => {
    setUploading(true)
    const formData = new FormData()
    formData.append('video', file)
    try {
      const res = await fetch(`${API}/api/upload`, { method: 'POST', body: formData })
      const data = await readJsonResponse(res)
      if (res.ok) setUploadInfo({ ...data, originalName: file.name })
      else alert(data.error)
    } catch (e) { alert('Upload failed: ' + e.message) }
    setUploading(false)
  }

  const startAnalysis = async () => {
    if (!uploadInfo) return
    try {
      const res = await fetch(`${API}/api/analyze/${uploadInfo.job_id}`, { method: 'POST' })
      const data = await readJsonResponse(res)
      if (!res.ok) throw new Error(data.error || 'Analysis could not be started')
      onUpload(uploadInfo.job_id)
    } catch (e) { alert('Failed to start: ' + e.message) }
  }

  const deleteJob = async (jobId) => {
    if (!window.confirm(`Delete analysis ${jobId}? This removes its video and JSON output.`)) return
    try {
      const res = await fetch(`${API}/api/jobs/${jobId}`, { method: 'DELETE' })
      const data = await readJsonResponse(res)
      if (!res.ok) throw new Error(data.error || 'Could not delete analysis')
      setPreviousJobs(jobs => jobs.filter(job => job.job_id !== jobId))
    } catch (e) {
      alert('Delete failed: ' + e.message)
    }
  }

  return (
    <div className="panel upload-panel">
      <div
        className={`upload-zone ${dragActive ? 'drag-active' : ''}`}
        onDragOver={(e) => { e.preventDefault(); setDragActive(true) }}
        onDragLeave={() => setDragActive(false)}
        onDrop={handleDrop}
        onClick={() => !uploadInfo && inputRef.current?.click()}
      >
        <input ref={inputRef} type="file" accept=".mp4,.avi,.mov,.mkv" onChange={handleFileSelect} hidden />

        {!uploadInfo ? (
          <>
            <div className="upload-icon">📹</div>
            <div className="upload-title">{uploading ? 'Uploading...' : 'Drop Video Here'}</div>
            <div className="upload-subtitle">or click to browse — MP4, AVI, MOV supported</div>
            <button className="upload-btn" onClick={(e) => { e.stopPropagation(); inputRef.current?.click() }}>
              SELECT VIDEO
            </button>
          </>
        ) : (
          <>
            <div className="upload-icon">✅</div>
            <div className="upload-title">Video Uploaded</div>
            <div className="upload-info">
              <div className="filename">{uploadInfo.originalName}</div>
              <div className="meta">{uploadInfo.frames} frames · {uploadInfo.resolution} · {Math.round(uploadInfo.fps)} fps</div>
              {uploadInfo.sampled && <div className="meta">{uploadInfo.message}</div>}
            </div>
            <button className="start-btn" onClick={startAnalysis}>▶ START ANALYSIS</button>
          </>
        )}
      </div>

      {previousJobs.length > 0 && !uploadInfo && (
        <div className="previous-jobs-section">
          <h3>PAST ANALYSES</h3>
          <div className="previous-jobs-list">
            {previousJobs.map(job => (
              <div key={job.job_id} className="previous-job-row">
                <div className="previous-job-meta">
                  <span>ID: {job.job_id}</span>
                  {job.completed_at && <small>{new Date(job.completed_at).toLocaleString()}</small>}
                </div>
                <div className="previous-job-actions">
                  <button className="compact-btn" onClick={(e) => { e.stopPropagation(); onLoadExisting(job.job_id); }}>
                    LOAD
                  </button>
                  <button className="compact-btn danger" onClick={(e) => { e.stopPropagation(); deleteJob(job.job_id); }}>
                    DELETE
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

function ProcessingMonitor({ stage, progress, message }) {
  const stages = [
    { key: 'reading_video', label: 'READ VIDEO' },
    { key: 'player_detection', label: 'PLAYERS' },
    { key: 'ball_detection', label: 'BALL' },
    { key: 'court_detection', label: 'COURT' },
    { key: 'post_processing', label: 'ANALYSIS' },
    { key: 'exporting_data', label: 'DATA EXPORT' },
    { key: 'rendering_video', label: 'RENDER' },
  ]

  const stageOrder = stages.map(s => s.key)
  const currentIdx = stageOrder.indexOf(stage)

  // Overall progress (each stage contributes equally)
  const stageWeight = 100 / stages.length
  const overallProgress = Math.min(100, currentIdx * stageWeight + (progress / 100) * stageWeight)

  return (
    <div className="panel processing-panel">
      <div className="processing-container">
        <div className="progress-pct">{Math.round(overallProgress)}%</div>
        <div className="progress-bar-container">
          <div className="progress-bar-fill" style={{ width: `${overallProgress}%` }}></div>
        </div>
        <div className="processing-title">Analyzing Video</div>
        <div className="processing-stages">
          {stages.map((s, i) => (
            <div key={s.key} className={`stage-chip ${i === currentIdx ? 'active' : i < currentIdx ? 'complete' : ''}`}>
              {i < currentIdx ? '✓ ' : ''}{s.label}
            </div>
          ))}
        </div>
        <div className="processing-message">{message}</div>
      </div>
    </div>
  )
}

function VideoPlayer({ jobId, onFrameChange }) {
  const videoRef = useRef(null)
  const [playing, setPlaying] = useState(false)
  const [currentTime, setCurrent] = useState(0)
  const [duration, setDuration] = useState(0)

  const videoSrc = jobId ? `${API}/api/video/${jobId}` : null

  useEffect(() => {
    const video = videoRef.current
    if (!video) return
    const onTime = () => {
      setCurrent(video.currentTime)
      // Estimate frame number (24 fps)
      const frameNum = Math.floor(video.currentTime * 24)
      if (onFrameChange) onFrameChange(frameNum)
    }
    const onDur = () => setDuration(video.duration)
    video.addEventListener('timeupdate', onTime)
    video.addEventListener('loadedmetadata', onDur)
    return () => {
      video.removeEventListener('timeupdate', onTime)
      video.removeEventListener('loadedmetadata', onDur)
    }
  }, [videoSrc, onFrameChange])

  const togglePlay = () => {
    const v = videoRef.current
    if (!v) return
    if (v.paused) { v.play(); setPlaying(true) }
    else { v.pause(); setPlaying(false) }
  }

  const seek = (e) => {
    const v = videoRef.current
    if (!v) return
    v.currentTime = parseFloat(e.target.value)
  }

  const stepFrame = (dir) => {
    const v = videoRef.current
    if (!v) return
    v.pause()
    setPlaying(false)
    v.currentTime = Math.max(0, Math.min(v.duration, v.currentTime + (dir / 24)))
  }

  const formatTime = (t) => {
    const m = Math.floor(t / 60)
    const s = Math.floor(t % 60)
    return `${m}:${String(s).padStart(2, '0')}`
  }

  if (!videoSrc) return <div className="empty-state"><span className="icon">📹</span>No video loaded</div>

  return (
    <div className="video-container">
      <video ref={videoRef} src={videoSrc} preload="auto" />
      <div className="video-controls">
        <button onClick={() => stepFrame(-1)}>⏮</button>
        <button onClick={togglePlay}>{playing ? '⏸' : '▶'}</button>
        <button onClick={() => stepFrame(1)}>⏭</button>
        <input
          type="range"
          className="video-seek"
          min={0}
          max={duration || 1}
          step={0.001}
          value={currentTime}
          onChange={seek}
        />
        <div className="video-time">{formatTime(currentTime)} / {formatTime(duration)}</div>
      </div>
    </div>
  )
}

function buildCourtBackground(courtW, courtH, scale) {
  const background = document.createElement('canvas')
  background.width = courtW * scale
  background.height = courtH * scale
  const ctx = background.getContext('2d')
  ctx.scale(scale, scale)

  const accent = 'rgba(0, 255, 200, 0.44)'
  const major = 'rgba(224, 231, 239, 0.72)'
  const minor = 'rgba(224, 231, 239, 0.34)'
  const laneFill = 'rgba(59, 130, 246, 0.16)'
  const runoffFill = 'rgba(0, 255, 200, 0.08)'
  const court = { x: 14, y: 11, w: 272, h: 139 }
  const meter = court.w / 28
  const centerX = court.x + court.w / 2
  const centerY = court.y + court.h / 2
  const hoopInset = 1.575 * meter
  const leftHoopX = court.x + hoopInset
  const rightHoopX = court.x + court.w - hoopInset
  const keyW = 4.9 * meter
  const keyDepth = 5.8 * meter
  const ftRadius = 1.8 * meter
  const restrictedRadius = 1.25 * meter
  const threeRadius = 6.75 * meter
  const cornerThreeY = 0.9 * meter
  const laneMarkGap = 0.18 * meter

  const line = (color = major, width = 1) => {
    ctx.strokeStyle = color
    ctx.lineWidth = width
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
  }
  const strokeLine = (x1, y1, x2, y2) => {
    ctx.beginPath()
    ctx.moveTo(x1, y1)
    ctx.lineTo(x2, y2)
    ctx.stroke()
  }
  const strokeArc = (x, y, r, start, end, dashed = false) => {
    ctx.save()
    if (dashed) ctx.setLineDash([4, 4])
    ctx.beginPath()
    ctx.arc(x, y, r, start, end)
    ctx.stroke()
    ctx.restore()
  }
  const laneMarks = (side) => {
    const baseX = side === 'left' ? court.x : court.x + court.w
    const dir = side === 'left' ? 1 : -1
    const marks = [0.85, 1.75, 2.95, 4.1].map((m) => baseX + dir * m * meter)
    marks.forEach((x, index) => {
      const length = index === 0 ? 5 : 3.5
      strokeLine(x, centerY - keyW / 2, x, centerY - keyW / 2 - length)
      strokeLine(x, centerY + keyW / 2, x, centerY + keyW / 2 + length)
    })
    strokeLine(baseX + dir * 0.1 * meter, centerY - laneMarkGap, baseX + dir * 0.1 * meter, centerY + laneMarkGap)
  }

  ctx.fillStyle = '#08111f'
  ctx.fillRect(0, 0, courtW, courtH)
  ctx.fillStyle = runoffFill
  ctx.fillRect(4, 4, courtW - 8, courtH - 8)
  ctx.fillStyle = '#0d1a2d'
  ctx.fillRect(court.x, court.y, court.w, court.h)

  line('rgba(0, 255, 200, 0.06)', 0.5)
  for (let x = court.x + meter * 2; x < court.x + court.w; x += meter * 2) strokeLine(x, court.y, x, court.y + court.h)
  for (let y = court.y + meter * 2; y < court.y + court.h; y += meter * 2) strokeLine(court.x, y, court.x + court.w, y)

  line(major, 1.4)
  ctx.strokeRect(court.x, court.y, court.w, court.h)
  strokeLine(centerX, court.y, centerX, court.y + court.h)
  strokeArc(centerX, centerY, 1.8 * meter, 0, Math.PI * 2)
  line(accent, 1)
  strokeArc(centerX, centerY, 0.75 * meter, 0, Math.PI * 2)

  line(major, 1.15)
  const topCornerY = court.y + cornerThreeY
  const bottomCornerY = court.y + court.h - cornerThreeY
  const cornerDy = topCornerY - centerY
  const cornerDx = Math.sqrt(Math.max(0, threeRadius ** 2 - cornerDy ** 2))
  const topArcAngle = Math.atan2(cornerDy, cornerDx)
  const bottomArcAngle = Math.atan2(-cornerDy, cornerDx)
  strokeLine(court.x, topCornerY, leftHoopX + cornerDx, topCornerY)
  strokeLine(court.x, bottomCornerY, leftHoopX + cornerDx, bottomCornerY)
  strokeArc(leftHoopX, centerY, threeRadius, topArcAngle, bottomArcAngle)
  strokeLine(court.x + court.w, topCornerY, rightHoopX - cornerDx, topCornerY)
  strokeLine(court.x + court.w, bottomCornerY, rightHoopX - cornerDx, bottomCornerY)
  strokeArc(rightHoopX, centerY, threeRadius, Math.PI - bottomArcAngle, Math.PI - topArcAngle)

  ;[
    { side: 'left', base: court.x, hoop: leftHoopX, dir: 1 },
    { side: 'right', base: court.x + court.w, hoop: rightHoopX, dir: -1 },
  ].forEach(({ side, base, hoop, dir }) => {
    const ftX = base + dir * keyDepth
    const keyX = side === 'left' ? base : ftX
    ctx.fillStyle = laneFill
    ctx.fillRect(keyX, centerY - keyW / 2, keyDepth, keyW)
    line(major, 1.2)
    ctx.strokeRect(keyX, centerY - keyW / 2, keyDepth, keyW)
    strokeArc(ftX, centerY, ftRadius, side === 'left' ? -Math.PI / 2 : Math.PI / 2, side === 'left' ? Math.PI / 2 : Math.PI * 1.5)
    strokeArc(ftX, centerY, ftRadius, side === 'left' ? Math.PI / 2 : -Math.PI / 2, side === 'left' ? Math.PI * 1.5 : Math.PI / 2, true)
    strokeArc(hoop, centerY, restrictedRadius, side === 'left' ? -Math.PI / 2 : Math.PI / 2, side === 'left' ? Math.PI / 2 : Math.PI * 1.5)
    line(minor, 1)
    laneMarks(side)
    strokeLine(hoop - dir * 0.5 * meter, centerY - 0.9 * meter, hoop - dir * 0.5 * meter, centerY + 0.9 * meter)
    line(accent, 1.2)
    ctx.beginPath()
    ctx.arc(hoop, centerY, 0.23 * meter, 0, Math.PI * 2)
    ctx.stroke()
  })

  line(minor, 1)
  ;[court.x + court.w * 0.3, centerX, court.x + court.w * 0.7].forEach((x) => {
    strokeLine(x, court.y, x, court.y + 4)
    strokeLine(x, court.y + court.h, x, court.y + court.h - 4)
  })

  return background
}

function TacticalRadar({ frameData }) {
  const canvasRef = useRef(null)
  const courtBackgroundRef = useRef(null)
  const animationFrameRef = useRef(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')

    const courtW = 300
    const courtH = 161
    const pixelRatio = Math.min(window.devicePixelRatio || 1, 2)
    const canvasW = courtW * pixelRatio
    const canvasH = courtH * pixelRatio

    if (canvas.width !== canvasW || canvas.height !== canvasH) {
      canvas.width = canvasW
      canvas.height = canvasH
      canvas.style.aspectRatio = `${courtW} / ${courtH}`
    }

    if (!courtBackgroundRef.current) {
      courtBackgroundRef.current = buildCourtBackground(courtW, courtH, pixelRatio)
    }

    window.cancelAnimationFrame(animationFrameRef.current)
    animationFrameRef.current = window.requestAnimationFrame(() => {
      ctx.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0)
      ctx.clearRect(0, 0, courtW, courtH)
      ctx.drawImage(courtBackgroundRef.current, 0, 0, courtW, courtH)

      if (!frameData?.players) return

      const team1Players = []
      const team2Players = []
      const players = Object.entries(frameData.players)

      players.forEach(([, p]) => {
        if (!p.tactical_position) return
        if (p.team === 1) team1Players.push(p.tactical_position)
        else team2Players.push(p.tactical_position)
      })

      const drawConnections = (teamPlayers, color) => {
        if (teamPlayers.length < 2) return
        ctx.strokeStyle = color
        ctx.lineWidth = 0.5
        ctx.setLineDash([4, 5])
        ctx.beginPath()
        for (let i = 1; i < teamPlayers.length; i++) {
          ctx.moveTo(teamPlayers[i - 1][0], teamPlayers[i - 1][1])
          ctx.lineTo(teamPlayers[i][0], teamPlayers[i][1])
        }
        ctx.stroke()
        ctx.setLineDash([])
      }

      drawConnections(team1Players, 'rgba(0, 212, 170, 0.2)')
      drawConnections(team2Players, 'rgba(224, 231, 239, 0.15)')

      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      players.forEach(([pid, p]) => {
        if (!p.tactical_position) return
        const [x, y] = p.tactical_position
        const color = p.team === 1 ? '#00d4aa' : '#e0e7ef'

        ctx.beginPath()
        ctx.arc(x, y, 6, 0, Math.PI * 2)
        ctx.fillStyle = color
        ctx.fill()

        ctx.fillStyle = '#0d1a2d'
        ctx.font = 'bold 7px JetBrains Mono'
        ctx.fillText(pid, x, y)

        if (p.speed_kmh > 0) {
          ctx.fillStyle = 'rgba(255,255,255,0.5)'
          ctx.font = '5px JetBrains Mono'
          ctx.fillText(`${p.speed_kmh.toFixed(0)}km/h`, x, y + 12)
        }
      })
    })

    return () => window.cancelAnimationFrame(animationFrameRef.current)
  }, [frameData])

  if (!frameData) {
    return (
      <div className="graph-loading">
        <div className="graph-loader-orbit" />
        <div className="graph-loader-grid">
          <span />
          <span />
          <span />
        </div>
        <div className="graph-loader-copy">
          <strong>Building tactical surface</strong>
          <span>Waiting for frame analytics</span>
        </div>
      </div>
    )
  }

  return (
    <div className="tactical-container graph-3d-surface">
      <canvas ref={canvasRef} className="tactical-canvas" style={{ maxWidth: '100%', maxHeight: '100%' }} />
      <div className="tactical-legend">
        <div className="tactical-legend-item">
          <span className="dot" style={{ background: 'var(--team1-color)' }}></span>Team 1
        </div>
        <div className="tactical-legend-item">
          <span className="dot" style={{ background: 'var(--team2-color)' }}></span>Team 2
        </div>
      </div>
    </div>
  )
}

function IntelligenceFeed({ events, onJump }) {
  return (
    <ul className="intel-list">
      {events.length === 0 && (
        <li className="empty-state" style={{ padding: '20px' }}>
          <span className="icon">⚡</span>Events will appear here during playback
        </li>
      )}
      {events.slice().reverse().map((ev, i) => (
        <li key={i} className="intel-item fade-in" onClick={() => onJump?.(ev.frame)}>
          <span className="intel-frame">{ev.frame === null || ev.frame === undefined ? '[F---]' : `[F${String(ev.frame).padStart(3, '0')}]`}</span>
          <span className="intel-icon">{ev.icon}</span>
          <span className="intel-text" dangerouslySetInnerHTML={{ __html: ev.text }}></span>
        </li>
      ))}
    </ul>
  )
}

function PlayerTable({ frameData }) {
  const [sortKey, setSortKey] = useState('speed_kmh')
  const [sortDir, setSortDir] = useState(-1)

  if (!frameData || !frameData.players) {
    return <div className="empty-state"><span className="icon">👤</span>No player data</div>
  }

  const players = Object.entries(frameData.players)
    .map(([pid, p]) => ({ id: pid, ...p }))
    .sort((a, b) => (a[sortKey] > b[sortKey] ? sortDir : -sortDir))

  const toggleSort = (key) => {
    if (sortKey === key) setSortDir(d => -d)
    else { setSortKey(key); setSortDir(-1) }
  }

  return (
    <table className="player-table">
      <thead>
        <tr>
          <th onClick={() => toggleSort('id')}>ID</th>
          <th onClick={() => toggleSort('team')}>TEAM</th>
          <th onClick={() => toggleSort('speed_kmh')}>SPEED</th>
          <th onClick={() => toggleSort('total_distance_m')}>DISTANCE</th>
        </tr>
      </thead>
      <tbody>
        {players.map(p => (
          <tr key={p.id}>
            <td style={{ fontWeight: 600, color: 'var(--text-primary)' }}>#{p.id}</td>
            <td><span className="team-dot" style={{ background: p.team === 1 ? 'var(--team1-color)' : 'var(--team2-color)' }}></span>Team {p.team}</td>
            <td>{p.speed_kmh.toFixed(1)} <span style={{ color: 'var(--text-dim)', fontSize: 10 }}>km/h</span></td>
            <td>{p.total_distance_m.toFixed(1)} <span style={{ color: 'var(--text-dim)', fontSize: 10 }}>m</span></td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

function ScoreRing({ value, label, team }) {
  const angle = `${clampScore(value) * 3.6}deg`
  return (
    <div className="score-ring-wrap">
      <div
        className={`score-ring team-${team}`}
        style={{ background: `conic-gradient(var(--ring-color) ${angle}, rgba(255,255,255,0.07) 0deg)` }}
      >
        <div>
          <strong>{clampScore(value)}</strong>
          <span>/100</span>
        </div>
      </div>
      <div className="score-ring-label">{label}</div>
    </div>
  )
}

function RadarChart({ teams, categories }) {
  const size = 240
  const center = size / 2
  const maxRadius = 88
  const pointsFor = (team) => categories.map((category, index) => {
    const angle = (Math.PI * 2 * index) / categories.length - Math.PI / 2
    const radius = (team.scores[category.key] / 100) * maxRadius
    return `${center + Math.cos(angle) * radius},${center + Math.sin(angle) * radius}`
  }).join(' ')

  const gridLevels = [0.33, 0.66, 1]
  const axisPoints = categories.map((category, index) => {
    const angle = (Math.PI * 2 * index) / categories.length - Math.PI / 2
    return {
      ...category,
      x: center + Math.cos(angle) * (maxRadius + 22),
      y: center + Math.sin(angle) * (maxRadius + 22),
      axisX: center + Math.cos(angle) * maxRadius,
      axisY: center + Math.sin(angle) * maxRadius,
    }
  })

  return (
    <div className="radar-card">
      <div className="viz-title">Team Radar Comparison</div>
      <svg className="radar-chart" viewBox={`0 0 ${size} ${size}`} role="img" aria-label="Team tactical radar comparison">
        {gridLevels.map(level => (
          <polygon
            key={level}
            className="radar-grid"
            points={categories.map((_, index) => {
              const angle = (Math.PI * 2 * index) / categories.length - Math.PI / 2
              return `${center + Math.cos(angle) * maxRadius * level},${center + Math.sin(angle) * maxRadius * level}`
            }).join(' ')}
          />
        ))}
        {axisPoints.map(point => (
          <g key={point.key}>
            <line className="radar-axis" x1={center} y1={center} x2={point.axisX} y2={point.axisY} />
            <text className="radar-label" x={point.x} y={point.y}>{point.label}</text>
          </g>
        ))}
        {teams.map(team => (
          <polygon key={team.id} className={`radar-area team-${team.id}`} points={pointsFor(team)} />
        ))}
      </svg>
      <div className="radar-legend">
        {teams.map(team => <span key={team.id} className={`team-${team.id}`}>{team.name}</span>)}
      </div>
    </div>
  )
}

function RiskBars({ teams }) {
  return (
    <div className="risk-card">
      <div className="viz-title">Mistake / Risk Breakdown</div>
      <div className="risk-columns">
        {teams.map(team => (
          <div key={team.id} className="risk-team">
            <div className="risk-team-title">{team.name}</div>
            {team.risks.map(risk => (
              <div key={risk.label} className="risk-row">
                <div className="risk-meta">
                  <span>{risk.label}</span>
                  <strong>{risk.value}</strong>
                </div>
                <div className="risk-track">
                  <div className={`risk-fill team-${team.id}`} style={{ width: `${risk.value}%` }} />
                </div>
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  )
}

function PerformanceLineChart({ teams, categories }) {
  const width = 620
  const height = 270
  const padding = { top: 24, right: 22, bottom: 62, left: 42 }
  const chartWidth = width - padding.left - padding.right
  const chartHeight = height - padding.top - padding.bottom
  const xFor = (index) => padding.left + (chartWidth * index) / Math.max(categories.length - 1, 1)
  const yFor = (score) => padding.top + chartHeight - (clampScore(score) / 100) * chartHeight
  const pathFor = (team) => categories
    .map((category, index) => `${index === 0 ? 'M' : 'L'} ${xFor(index)} ${yFor(team.scores[category.key])}`)
    .join(' ')

  return (
    <div className="line-card">
      <div className="viz-title">Performance Line Profile</div>
      <svg className="performance-line-chart" viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Advanced analytics performance line profile by team">
        {[25, 50, 75, 100].map(value => (
          <g key={value}>
            <line className="line-grid" x1={padding.left} y1={yFor(value)} x2={width - padding.right} y2={yFor(value)} />
            <text className="line-y-label" x={padding.left - 10} y={yFor(value)}>{value}</text>
          </g>
        ))}
        {categories.map((category, index) => (
          <g key={category.key}>
            <line className="line-axis-tick" x1={xFor(index)} y1={padding.top} x2={xFor(index)} y2={height - padding.bottom} />
            <text className="line-x-label" x={xFor(index)} y={height - 38}>
              {(category.lineLabel || [category.label]).map((line, lineIndex) => (
                <tspan key={line} x={xFor(index)} dy={lineIndex === 0 ? 0 : 13}>{line}</tspan>
              ))}
            </text>
          </g>
        ))}
        {teams.map(team => (
          <g key={team.id} className={`line-team team-${team.id}`}>
            <path d={pathFor(team)} />
            {categories.map((category, index) => (
              <g key={category.key}>
                <circle cx={xFor(index)} cy={yFor(team.scores[category.key])} r="5" />
                <title>{`${team.name} ${category.label}: ${team.scores[category.key]}`}</title>
              </g>
            ))}
          </g>
        ))}
      </svg>
      <div className="line-note">Scores are derived from advanced analytics text evidence for this analyzed clip.</div>
    </div>
  )
}

function PossessionFlow({ flow }) {
  if (!flow.length) return null
  return (
    <div className="flow-card">
      <div className="viz-title">Possession Story Flow</div>
      <div className="flow-path">
        {flow.map((node, index) => (
          <div key={`${node.label}-${index}`} className="flow-node-wrap">
            <div className="flow-node">
              <strong>{node.label}</strong>
              <span>{node.detail}</span>
            </div>
            {index < flow.length - 1 && <div className="flow-connector">→</div>}
          </div>
        ))}
      </div>
    </div>
  )
}

function GeminiVisualization({ report }) {
  const [introLoading, setIntroLoading] = useState(true)
  const viz = buildGeminiVisualization(report.report, report.corrected_analytics || {})

  useEffect(() => {
    const timer = window.setTimeout(() => setIntroLoading(false), 1150)
    return () => window.clearTimeout(timer)
  }, [])

  if (introLoading) {
    return (
      <section className="gemini-viz">
        <div className="gemini-viz-header">
          <div>
            <span>ADVANCED ANALYTICS VISUALIZATION</span>
            <p>Segment-level interpretation from the existing advanced review.</p>
          </div>
          <div className="confidence-pill loading">Generating maps</div>
        </div>
        <div className="gemini-graph-loading-grid">
          <GraphLoadingCard title="Segment interpretation map" />
          <GraphLoadingCard title="Team radar map" />
          <GraphLoadingCard title="Mistake risk breakdown map" />
          <GraphLoadingCard title="Performance line map" />
        </div>
      </section>
    )
  }

  return (
    <section className="gemini-viz">
      <div className="gemini-viz-header">
        <div>
          <span>ADVANCED ANALYTICS VISUALIZATION</span>
          <p>Segment-level interpretation from the existing advanced review.</p>
        </div>
        <div className="confidence-pill">Scope: analyzed clip</div>
      </div>

      <div className="score-grid">
        {viz.teams.map(team => (
          <div key={team.id} className={`team-score-card team-${team.id}`}>
            <ScoreRing value={team.overall} label={`${team.name} Segment Score`} team={team.id} />
            <div className="score-breakdown">
              {viz.categories.map(category => (
                <div key={category.key}>
                  <span>{category.label}</span>
                  <strong>{team.scores[category.key]}</strong>
                </div>
              ))}
            </div>
            <div className="score-confidence">Confidence: {team.confidence}</div>
          </div>
        ))}
      </div>

      <div className="viz-grid">
        <RadarChart teams={viz.teams} categories={viz.categories} />
        <RiskBars teams={viz.teams} />
      </div>

      <PerformanceLineChart teams={viz.teams} categories={viz.categories} />

      <div className="viz-grid lower">
        <PossessionFlow flow={viz.flow} />
        <div className="recommendation-card">
          <div className="viz-title">Recommendation Priority</div>
          {viz.teams.map(team => (
            <div key={team.id} className="recommendation-team">
              <div className="risk-team-title">{team.name}</div>
              {(team.recommendations.length ? team.recommendations : ['No urgent recommendation detected from this segment.']).map((item, index) => (
                <div key={`${team.id}-${index}`} className="recommendation-row">
                  <span>{item}</span>
                  <strong>{team.risks[0]?.value ?? 0}</strong>
                </div>
              ))}
            </div>
          ))}
        </div>
      </div>

      {viz.tags.length > 0 && (
        <div className="tactical-tags" aria-label="Detected tactical tags">
          {viz.tags.map(tag => <span key={tag.label} title={tag.description}>{tag.label}</span>)}
        </div>
      )}
    </section>
  )
}

function GraphLoadingCard({ title }) {
  return (
    <div className="graph-loading-card">
      <div className="graph-loader-orbit" />
      <div className="graph-loader-grid">
        <span />
        <span />
        <span />
      </div>
      <div className="graph-loader-copy">
        <strong>{title}</strong>
        <span>Interpreting advanced analytics signals</span>
      </div>
    </div>
  )
}

function ExpertAnalysisPage({ jobId, onBack, onExpertReport }) {
  const [loading, setLoading] = useState(false)
  const [report, setReport] = useState(null)
  const [error, setError] = useState('')

  const runExpertAnalysis = useCallback(async (forceRefresh = false) => {
    if (!jobId) return
    setLoading(true)
    setError('')
    try {
      const res = await fetch(`${API}/api/expert-analysis/${jobId}${forceRefresh ? '?refresh=1' : ''}`, { method: 'POST' })
      const data = await readJsonResponse(res)
      if (!res.ok) throw new Error(data.error || 'Advanced analytics failed')
      setReport(data)
      onExpertReport?.(data)
    } catch (e) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }, [jobId, onExpertReport])

  useEffect(() => {
    runExpertAnalysis()
  }, [runExpertAnalysis])

  return (
    <div className="panel expert-panel">
      <div className="panel-header expert-header">
        <span><span className="icon">◈</span> ADVANCED ANALYTICS</span>
        <div className="expert-actions">
          <button className="workspace-btn" onClick={() => runExpertAnalysis(true)} disabled={loading}>
            {loading ? 'ANALYZING...' : 'RE-RUN'}
          </button>
          <button className="workspace-btn" onClick={onBack}>DASHBOARD</button>
        </div>
      </div>
      <div className="panel-body expert-body">
        {loading && (
          <div className="expert-loading">
            <div className="progress-pct">AI</div>
            <div className="processing-title">Advanced analytics is reviewing the game</div>
            <div className="processing-message">Sending the annotated video and pipeline analytics for deeper tactical analysis.</div>
          </div>
        )}
        {error && <div className="expert-error">{error}</div>}
        {!loading && !error && report && (
          <>
            <div className="expert-meta">
              Model: {report.model} · Job: {report.job_id}
            </div>
            {report.corrected_analytics && (
              <div className="corrected-metrics">
                <div><span>T1 PASSES</span>{report.corrected_analytics.team1_passes ?? '—'}</div>
                <div><span>T2 PASSES</span>{report.corrected_analytics.team2_passes ?? '—'}</div>
                <div><span>T1 INTCPT</span>{report.corrected_analytics.team1_interceptions ?? '—'}</div>
                <div><span>T2 INTCPT</span>{report.corrected_analytics.team2_interceptions ?? '—'}</div>
                <div><span>T1 SHOTS</span>{report.corrected_analytics.team1_shots ?? '—'}</div>
                <div><span>T2 SHOTS</span>{report.corrected_analytics.team2_shots ?? '—'}</div>
                <div><span>T1 POSS.</span>{report.corrected_analytics.team1_ball_control_pct ?? '—'}%</div>
                <div><span>T2 POSS.</span>{report.corrected_analytics.team2_ball_control_pct ?? '—'}%</div>
              </div>
            )}
            <pre className="expert-report">{report.report}</pre>
            <GeminiVisualization key={`${report.job_id}-${report.report?.length ?? 0}`} report={report} />
          </>
        )}
      </div>
    </div>
  )
}


export default function App() {
  const [appState, setAppState] = useState('home') // home, upload, processing, dashboard, expert
  const [jobId, setJobId] = useState(null)
  const [progressInfo, setProgressInfo] = useState({ stage: '', progress: 0, message: '' })
  const [allFrameData, setAllFrameData] = useState(null)
  const [currentFrame, setCurrentFrame] = useState(0)
  const [totalFrames, setTotalFrames] = useState(0)
  const [, setSummary] = useState(null)
  const [events, setEvents] = useState([])
  const [expertReport, setExpertReport] = useState(null)
  const [dashboardSplit, setDashboardSplit] = useState({ x: 58, y: 58 })
  const dashboardRef = useRef(null)
  const loadJobData = useCallback(async (jobIdToLoad) => {
    try {
      const statusRes = await fetch(`${API}/api/status/${jobIdToLoad}`)
      const statusData = await readJsonResponse(statusRes)
      if(statusData.summary) {
        setSummary(statusData.summary)
        setTotalFrames(statusData.summary.total_frames)
      }

      const res = await fetch(`${API}/api/results/${jobIdToLoad}`)
      const json = await readJsonResponse(res)
      setAllFrameData(json.frames)
      
      setEvents(buildPipelineEvents(json.frames))
      setExpertReport(null)
      setJobId(jobIdToLoad)
      setAppState('dashboard')
    } catch (e) {
      console.error('Failed to load results', e)
      alert("Error loading past analysis.")
    }
  }, [])

  // Poll while processing so analysis works even if live socket events are missed.
  useEffect(() => {
    if (appState !== 'processing' || !jobId) return

    let cancelled = false
    const pollStatus = async () => {
      try {
        const res = await fetch(`${API}/api/status/${jobId}`)
        const data = await readJsonResponse(res)
        if (!res.ok) throw new Error(data.error || 'Could not read analysis status')
        if (cancelled) return

        setProgressInfo({
          stage: data.stage || data.status,
          progress: data.progress || 0,
          message: data.message || (data.status === 'queued' ? 'Waiting to start...' : '')
        })

        if (data.status === 'complete') {
          await loadJobData(jobId)
        } else if (data.status === 'error') {
          alert('Analysis error: ' + (data.error || 'Unknown error'))
          setAppState('upload')
        }
      } catch (e) {
        if (!cancelled) console.error('Could not poll analysis status', e)
      }
    }

    pollStatus()
    const intervalId = window.setInterval(pollStatus, 2000)
    return () => {
      cancelled = true
      window.clearInterval(intervalId)
    }
  }, [appState, jobId, loadJobData])

  useEffect(() => {
    if (!expertReport?.corrected_analytics || !allFrameData) return
    const geminiEvents = buildExpertEvents(expertReport.corrected_analytics)
    setEvents(geminiEvents.length > 0 ? geminiEvents : buildPipelineEvents(allFrameData))
  }, [expertReport, allFrameData])

  const handleUpload = (id) => {
    setJobId(id)
    setAppState('processing')
  }

  // Current frame data
  const frameData = allFrameData && currentFrame < allFrameData.length ? allFrameData[currentFrame] : null
  const correctedAnalytics = expertReport?.corrected_analytics
  // Stats for stats bar
  const stats = frameData ? {
    ...frameData.stats,
    ...(correctedAnalytics ? {
      team1_passes: correctedAnalytics.team1_passes ?? frameData.stats.team1_passes,
      team2_passes: correctedAnalytics.team2_passes ?? frameData.stats.team2_passes,
      team1_interceptions: correctedAnalytics.team1_interceptions ?? frameData.stats.team1_interceptions,
      team2_interceptions: correctedAnalytics.team2_interceptions ?? frameData.stats.team2_interceptions,
      team1_ball_control_pct: correctedAnalytics.team1_ball_control_pct ?? frameData.stats.team1_ball_control_pct,
      team2_ball_control_pct: correctedAnalytics.team2_ball_control_pct ?? frameData.stats.team2_ball_control_pct,
      team1_shots: correctedAnalytics.team1_shots,
      team2_shots: correctedAnalytics.team2_shots,
    } : {}),
    maxSpeed: Math.max(0, ...Object.values(frameData.players).map(p => p.speed_kmh)),
    totalPlayers: Object.keys(frameData.players).length,
  } : {
    team1_passes: 0, team2_passes: 0,
    team1_interceptions: 0, team2_interceptions: 0,
    team1_ball_control_pct: 0, team2_ball_control_pct: 0,
    team1_shots: 0, team2_shots: 0,
    maxSpeed: 0, totalPlayers: 0,
  }

  const handleFrameChange = (frame) => {
    setCurrentFrame(Math.max(0, Math.min(frame, totalFrames - 1)))
  }

  const startDashboardResize = (axis) => (event) => {
    event.preventDefault()
    const dashboard = dashboardRef.current
    if (!dashboard) return

    const rect = dashboard.getBoundingClientRect()
    const updateSplit = (clientX, clientY) => {
      setDashboardSplit((current) => {
        const next = { ...current }
        if (axis === 'x' || axis === 'both') {
          next.x = Math.min(75, Math.max(25, ((clientX - rect.left) / rect.width) * 100))
        }
        if (axis === 'y' || axis === 'both') {
          next.y = Math.min(75, Math.max(25, ((clientY - rect.top) / rect.height) * 100))
        }
        return next
      })
    }

    const onMouseMove = (moveEvent) => updateSplit(moveEvent.clientX, moveEvent.clientY)
    const onTouchMove = (moveEvent) => {
      const touch = moveEvent.touches[0]
      if (touch) updateSplit(touch.clientX, touch.clientY)
    }
    const stopResize = () => {
      window.removeEventListener('mousemove', onMouseMove)
      window.removeEventListener('mouseup', stopResize)
      window.removeEventListener('touchmove', onTouchMove)
      window.removeEventListener('touchend', stopResize)
      document.body.classList.remove('is-resizing-dashboard')
    }

    document.body.classList.add('is-resizing-dashboard')
    window.addEventListener('mousemove', onMouseMove)
    window.addEventListener('mouseup', stopResize)
    window.addEventListener('touchmove', onTouchMove, { passive: false })
    window.addEventListener('touchend', stopResize)
  }

  const layoutClass = appState === 'home' ? 'home-mode' : appState === 'upload' ? 'upload-mode' : appState === 'processing' ? 'processing-mode' : appState === 'expert' ? 'expert-mode' : ''

  return (
    <div className={`app-layout ${layoutClass}`}>
      <Header
        status={appState === 'dashboard' ? 'complete' : appState === 'processing' ? 'running' : 'idle'}
        currentFrame={currentFrame}
        totalFrames={totalFrames}
        appState={appState}
        canOpenDashboard={Boolean(allFrameData)}
        canOpenExpert={Boolean(jobId && allFrameData)}
        onNavigate={(page) => {
          if (page === 'expert' && !(jobId && allFrameData)) return
          if (page === 'dashboard' && !allFrameData) return
          setAppState(page)
        }}
      />

      {appState === 'home' && (
        <HomeScreen
          onStart={() => setAppState('upload')}
          canOpenDashboard={Boolean(allFrameData)}
          onOpenDashboard={() => setAppState('dashboard')}
        />
      )}

      {appState === 'upload' && (
        <VideoUpload onUpload={handleUpload} onLoadExisting={loadJobData} />
      )}

      {appState === 'processing' && (
        <ProcessingMonitor {...progressInfo} />
      )}

      {appState === 'expert' && (
        <ExpertAnalysisPage jobId={jobId} onBack={() => setAppState('dashboard')} onExpertReport={setExpertReport} />
      )}

      {appState === 'dashboard' && (
        <>
          <StatsBar stats={stats} />

          <div
            ref={dashboardRef}
            className="dashboard-workspace"
            style={{
              '--dashboard-left': `${dashboardSplit.x}%`,
              '--dashboard-top': `${dashboardSplit.y}%`
            }}
          >
            <button className="ai-expert-launch" onClick={() => setAppState('expert')}>
              ADVANCED ANALYTICS
            </button>
            <div className="panel video-panel">
              <div className="panel-header"><span className="icon">📹</span> AUGMENTED REALITY FEED</div>
              <div className="panel-body" style={{ padding: 0 }}>
                <VideoPlayer jobId={jobId} onFrameChange={handleFrameChange} />
              </div>
            </div>

            <div className="panel tactical-panel">
              <div className="panel-header"><span className="icon">🎯</span> TACTICAL RADAR</div>
              <div className="panel-body graph-panel-body" style={{ padding: 0 }}>
                <TacticalRadar frameData={frameData} />
              </div>
            </div>

            <div className="panel intel-panel">
              <div className="panel-header"><span className="icon">⚡</span> INTELLIGENCE FEED</div>
              <div className="panel-body">
                <IntelligenceFeed events={events} />
              </div>
            </div>

            <div className="panel player-panel">
              <div className="panel-header"><span className="icon">👤</span> PLAYER ANALYTICS</div>
              <div className="panel-body" style={{ padding: 0 }}>
                <PlayerTable frameData={frameData} />
              </div>
            </div>

            <div className="dashboard-splitter vertical" onMouseDown={startDashboardResize('x')} onTouchStart={startDashboardResize('x')} />
            <div className="dashboard-splitter horizontal" onMouseDown={startDashboardResize('y')} onTouchStart={startDashboardResize('y')} />
            <div className="dashboard-splitter handle" onMouseDown={startDashboardResize('both')} onTouchStart={startDashboardResize('both')} />
          </div>
        </>
      )}
    </div>
  )
}
