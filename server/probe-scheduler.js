/**
 * Probe Scheduler - Concurrent probe execution with rate limiting
 *
 * Features:
 * - Concurrent execution (default 5 workers)
 * - Prevents duplicate probes for same channel/token/model
 * - Graceful error handling
 * - Task status tracking
 */

export class ProbeScheduler {
  constructor(options = {}) {
    this.maxConcurrent = options.maxConcurrent || 5
    this.running = new Map()  // key -> start time
    this.queue = []
    this.isRunning = false
    this.stats = {
      queued: 0,
      completed: 0,
      failed: 0,
      skipped: 0
    }
  }

  /**
   * Generate unique key for a probe task
   */
  static taskKey(task) {
    return `${task.channelId}:${task.tokenId}:${task.modelId}`
  }

  /**
   * Schedule a probe task
   * @param {Object} task - Probe task with channelId, tokenId, modelId, executor
   * @returns {boolean} - true if scheduled, false if already running
   */
  schedule(task) {
    const key = ProbeScheduler.taskKey(task)

    // Prevent duplicate probes
    if (this.running.has(key)) {
      console.log(`[ProbeScheduler] Task ${key} already running, skipped`)
      this.stats.skipped++
      return false
    }

    // Check if already in queue
    const existsInQueue = this.queue.some(t => ProbeScheduler.taskKey(t) === key)
    if (existsInQueue) {
      console.log(`[ProbeScheduler] Task ${key} already queued, skipped`)
      this.stats.skipped++
      return false
    }

    this.queue.push({ ...task, key, scheduledAt: Date.now() })
    this.stats.queued++
    return true
  }

  /**
   * Schedule multiple tasks
   */
  scheduleMany(tasks) {
    let scheduled = 0
    for (const task of tasks) {
      if (this.schedule(task)) scheduled++
    }
    return scheduled
  }

  /**
   * Execute a single probe task
   */
  async executeTask(task) {
    const { key, executor, channelId, tokenId, modelId } = task

    this.running.set(key, Date.now())

    try {
      console.log(`[ProbeScheduler] Starting probe: ${key}`)

      // Execute the probe (executor should return probe result)
      const result = await executor()

      this.stats.completed++
      console.log(`[ProbeScheduler] Completed probe: ${key} - status: ${result?.status}`)

      return { success: true, key, result }

    } catch (error) {
      this.stats.failed++
      console.error(`[ProbeScheduler] Failed probe: ${key}`, error.message)

      return {
        success: false,
        key,
        error: error.message || 'Unknown error',
        channelId,
        tokenId,
        modelId
      }

    } finally {
      this.running.delete(key)
    }
  }

  /**
   * Get available worker slots
   */
  getAvailableSlots() {
    return Math.max(0, this.maxConcurrent - this.running.size)
  }

  /**
   * Main scheduler loop
   */
  async run() {
    if (this.isRunning) {
      console.log('[ProbeScheduler] Already running, skipped')
      return
    }

    this.isRunning = true
    console.log(`[ProbeScheduler] Starting scheduler (max concurrent: ${this.maxConcurrent})`)

    try {
      while (this.queue.length > 0 || this.running.size > 0) {
        const availableSlots = this.getAvailableSlots()

        // Take tasks from queue
        const tasks = this.queue.splice(0, availableSlots)

        if (tasks.length > 0) {
          console.log(`[ProbeScheduler] Executing ${tasks.length} tasks (${this.running.size} running, ${this.queue.length} queued)`)

          // Execute tasks concurrently
          const promises = tasks.map(task => this.executeTask(task))
          await Promise.allSettled(promises)
        } else if (this.running.size > 0) {
          // Wait for running tasks to complete
          await new Promise(resolve => setTimeout(resolve, 1000))
        }
      }

      console.log(`[ProbeScheduler] All tasks completed`, this.stats)

    } catch (error) {
      console.error('[ProbeScheduler] Scheduler error:', error)
    } finally {
      this.isRunning = false
    }
  }

  /**
   * Run scheduler in background (non-blocking)
   */
  runInBackground() {
    this.run().catch(err => {
      console.error('[ProbeScheduler] Background scheduler error:', err)
    })
  }

  /**
   * Get current scheduler status
   */
  getStatus() {
    return {
      isRunning: this.isRunning,
      queued: this.queue.length,
      running: this.running.size,
      runningTasks: Array.from(this.running.entries()).map(([key, startTime]) => ({
        key,
        startTime,
        duration: Date.now() - startTime
      })),
      stats: { ...this.stats },
      availableSlots: this.getAvailableSlots()
    }
  }

  /**
   * Clear queue and reset
   */
  clear() {
    this.queue = []
    this.stats = {
      queued: 0,
      completed: 0,
      failed: 0,
      skipped: 0
    }
  }

  /**
   * Stop scheduler (wait for running tasks to complete)
   */
  async stop(timeout = 30000) {
    console.log('[ProbeScheduler] Stopping scheduler...')

    // Clear queue
    const remainingQueue = this.queue.length
    this.queue = []

    if (remainingQueue > 0) {
      console.log(`[ProbeScheduler] Cleared ${remainingQueue} queued tasks`)
    }

    // Wait for running tasks
    if (this.running.size > 0) {
      console.log(`[ProbeScheduler] Waiting for ${this.running.size} running tasks...`)

      const startTime = Date.now()
      while (this.running.size > 0 && Date.now() - startTime < timeout) {
        await new Promise(resolve => setTimeout(resolve, 500))
      }

      if (this.running.size > 0) {
        console.warn(`[ProbeScheduler] Timeout: ${this.running.size} tasks still running`)
      }
    }

    this.isRunning = false
    console.log('[ProbeScheduler] Stopped')
  }
}

/**
 * Global scheduler instance
 */
let globalScheduler = null

export function getGlobalScheduler(options) {
  if (!globalScheduler) {
    globalScheduler = new ProbeScheduler(options)
  }
  return globalScheduler
}

export function resetGlobalScheduler() {
  if (globalScheduler) {
    globalScheduler.stop().catch(console.error)
  }
  globalScheduler = null
}
