import { useEffect, useRef, useState } from 'react'
import { X, ArrowClockwise } from '@phosphor-icons/react'
import './probe-history-dialog.css'

/**
 * Probe History Dialog Component
 *
 * Features:
 * - Click timeline cell to open and highlight specific minute
 * - Auto-scroll to selected minute
 * - ESC key to close
 * - Show aggregated results per minute
 * - Display errors and token usage
 */

function formatDateTime(timestamp) {
  return new Date(timestamp).toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  })
}

function formatLatency(ms) {
  if (ms == null) return '-'
  if (ms < 1000) return `${Math.round(ms)} ms`
  return `${(ms / 1000).toFixed(2)} s`
}

function StatusBadge({ success, failure, unknown }) {
  if (success > 0 && failure === 0 && unknown === 0) {
    return <span className="history-badge badge-success">正常</span>
  }
  if (failure > 0 && success === 0 && unknown === 0) {
    return <span className="history-badge badge-error">失败</span>
  }
  if (success > 0 && failure > 0) {
    return <span className="history-badge badge-mixed">混合</span>
  }
  if (unknown > 0 && success === 0 && failure === 0) {
    return <span className="history-badge badge-unknown">未知</span>
  }
  return <span className="history-badge badge-partial">部分</span>
}

function ErrorList({ errors }) {
  if (!errors || errors.length === 0) return <span className="history-no-error">-</span>

  return (
    <details className="history-error-details">
      <summary>{errors.length} 个错误</summary>
      <ul className="history-error-list">
        {errors.map((err, i) => (
          <li key={i}>
            <span className="error-message">{err.message}</span>
            {err.count > 1 && <span className="error-count">×{err.count}</span>}
          </li>
        ))}
      </ul>
    </details>
  )
}

function TokenUsage({ inputTokens, outputTokens, cost }) {
  if (inputTokens == null && outputTokens == null) return '-'

  return (
    <div className="token-usage">
      <span title="输入 tokens">{inputTokens || 0}</span>
      <span className="token-separator">→</span>
      <span title="输出 tokens">{outputTokens || 0}</span>
      {cost != null && cost > 0 && (
        <span className="token-cost" title="预估成本">${cost.toFixed(6)}</span>
      )}
    </div>
  )
}

/**
 * Aggregate probe records by minute
 */
function aggregateByMinute(records) {
  const groups = {}

  for (const record of records) {
    const minute = Math.floor(record.time / 60000) * 60000

    if (!groups[minute]) {
      groups[minute] = {
        minute,
        records: [],
        successCount: 0,
        failureCount: 0,
        unknownCount: 0,
        latencies: [],
        errors: [],
        inputTokens: 0,
        outputTokens: 0,
        estimatedCost: 0
      }
    }

    const group = groups[minute]
    group.records.push(record)

    // Count by status
    if (record.status === 'ok') {
      group.successCount++
    } else if (record.status === 'error') {
      group.failureCount++
      if (record.error) {
        // Aggregate same errors
        const existing = group.errors.find(e => e.message === record.error)
        if (existing) {
          existing.count++
        } else {
          group.errors.push({ message: record.error, count: 1 })
        }
      }
    } else {
      group.unknownCount++
    }

    // Aggregate latencies
    if (record.latencyMs != null) {
      group.latencies.push(record.latencyMs)
    }

    // Aggregate token usage
    if (record.inputTokens != null) group.inputTokens += record.inputTokens
    if (record.outputTokens != null) group.outputTokens += record.outputTokens
    if (record.estimatedCost != null) group.estimatedCost += record.estimatedCost
  }

  // Calculate average latency
  for (const group of Object.values(groups)) {
    if (group.latencies.length > 0) {
      const sum = group.latencies.reduce((a, b) => a + b, 0)
      group.avgLatency = sum / group.latencies.length
    } else {
      group.avgLatency = null
    }
  }

  return Object.values(groups).sort((a, b) => b.minute - a.minute)
}

export default function ProbeHistoryDialog({ channel, model, selectedMinute, onClose }) {
  const [history, setHistory] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const dialogRef = useRef(null)
  const selectedRowRef = useRef(null)
  const tableBodyRef = useRef(null)

  // Load history data
  const loadHistory = async () => {
    setLoading(true)
    setError(null)

    try {
      const response = await fetch(
        `/api/probe-history?channelId=${encodeURIComponent(channel.id)}&modelId=${encodeURIComponent(model.id)}`
      )

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`)
      }

      const data = await response.json()

      // Aggregate by minute
      const aggregated = aggregateByMinute(data.records || [])
      setHistory(aggregated)

    } catch (err) {
      console.error('Failed to load probe history:', err)
      setError(err.message || '加载历史记录失败')
    } finally {
      setLoading(false)
    }
  }

  // Initial load
  useEffect(() => {
    loadHistory()
  }, [channel.id, model.id])

  // Auto-scroll to selected minute
  useEffect(() => {
    if (selectedRowRef.current && tableBodyRef.current) {
      // Use setTimeout to ensure DOM is updated
      setTimeout(() => {
        selectedRowRef.current?.scrollIntoView({
          behavior: 'smooth',
          block: 'center'
        })
      }, 100)
    }
  }, [selectedMinute, history])

  // Keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e) => {
      if (e.key === 'Escape') {
        onClose()
      }
    }

    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [onClose])

  // Prevent body scroll when dialog is open
  useEffect(() => {
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = ''
    }
  }, [])

  return (
    <div className="history-dialog-overlay" onClick={onClose}>
      <div
        ref={dialogRef}
        className="history-dialog"
        onClick={e => e.stopPropagation()}
        role="dialog"
        aria-labelledby="history-dialog-title"
        aria-modal="true"
      >
        {/* Header */}
        <div className="history-header">
          <div className="history-title-section">
            <h3 id="history-dialog-title">探测历史</h3>
            <div className="history-info">
              <span className="history-channel">{channel.name}</span>
              <span className="history-separator">•</span>
              <span className="history-model">{model.id}</span>
            </div>
          </div>
          <div className="history-actions">
            <button
              className="history-refresh-btn"
              onClick={loadHistory}
              disabled={loading}
              aria-label="刷新历史记录"
            >
              <ArrowClockwise size={16} />
            </button>
            <button
              className="history-close-btn"
              onClick={onClose}
              aria-label="关闭"
            >
              <X size={18} />
            </button>
          </div>
        </div>

        {/* Body */}
        <div className="history-body" ref={tableBodyRef}>
          {loading && (
            <div className="history-loading">
              <div className="loading-spinner"></div>
              <p>加载中...</p>
            </div>
          )}

          {error && (
            <div className="history-error" role="alert">
              <p>❌ {error}</p>
              <button onClick={loadHistory}>重试</button>
            </div>
          )}

          {!loading && !error && history.length === 0 && (
            <div className="history-empty">
              <p>暂无历史记录</p>
            </div>
          )}

          {!loading && !error && history.length > 0 && (
            <table className="history-table">
              <thead>
                <tr>
                  <th>时间</th>
                  <th>状态</th>
                  <th>成功</th>
                  <th>失败</th>
                  <th>未知</th>
                  <th>平均延迟</th>
                  <th>Token 用量</th>
                  <th>错误</th>
                </tr>
              </thead>
              <tbody>
                {history.map(item => (
                  <tr
                    key={item.minute}
                    ref={item.minute === selectedMinute ? selectedRowRef : null}
                    className={item.minute === selectedMinute ? 'selected' : ''}
                  >
                    <td className="history-time">{formatDateTime(item.minute)}</td>
                    <td>
                      <StatusBadge
                        success={item.successCount}
                        failure={item.failureCount}
                        unknown={item.unknownCount}
                      />
                    </td>
                    <td className="history-count">{item.successCount}</td>
                    <td className="history-count">{item.failureCount}</td>
                    <td className="history-count">{item.unknownCount}</td>
                    <td className="history-latency">{formatLatency(item.avgLatency)}</td>
                    <td className="history-tokens">
                      <TokenUsage
                        inputTokens={item.inputTokens}
                        outputTokens={item.outputTokens}
                        cost={item.estimatedCost}
                      />
                    </td>
                    <td className="history-errors">
                      <ErrorList errors={item.errors} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        {/* Footer */}
        <div className="history-footer">
          <span className="history-count-info">
            共 {history.length} 条记录
          </span>
          {selectedMinute && (
            <span className="history-selected-info">
              已定位到 {formatDateTime(selectedMinute)}
            </span>
          )}
        </div>
      </div>
    </div>
  )
}
