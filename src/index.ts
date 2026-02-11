import type { Plugin } from "@opencode-ai/plugin"

type DiffEditor = "code" | "cursor" | "antigravity" | "windsurf"
type DiffOS = "windows" | "linux"

interface DiffConfig {
  editor?: DiffEditor | string
  os?: DiffOS
}

interface BackupInfo {
  fileKey: string
  backupPath: string
  currentPath: string
  cleanupBackup: boolean
}

interface PreEditSnapshot {
  originalPath: string
  normalizedPath: string
  backupPath: string
  cleanupBackup: boolean
}

const DEFAULT_CONFIG_CONTENT = `{
  // Supported editors: "code", "cursor", "antigravity", "windsurf"
  "editor": "code",
  // Supported OS: "windows", "linux"
  "os": "linux"
}
`

let PROJECT_ROOT = ""
let BACKUP_DIR = ""
let DIFF_COMMAND_TEMPLATE = ""
let DIFF_CONFIG: DiffConfig | null = null
let configInitialized = false
let pendingBackupsByFile: Map<string, BackupInfo> = new Map()
let shownBackupsAwaitingCleanup: BackupInfo[] = []
let activeSnapshotsStack: PreEditSnapshot[][] = []
let backupDirCreated = false
let backupSequence = 0
let shownBackupsLastUpdatedAt = 0
let cleanupTimer: ReturnType<typeof setTimeout> | null = null

const CLEANUP_GRACE_MS = 15000

const normalizePathToKey = (filePath: string): string => filePath.replace(/\\/g, "/")

const getBackupFileName = (filePath: string): string => {
  const key = normalizePathToKey(filePath)
  const parts = key.split("/").filter(Boolean)
  const name = parts[parts.length - 1]
  if (!name) return "untitled"
  return name.replace(/[<>:"|?*]/g, "_")
}

const getParentDir = (filePath: string): string => {
  const idx = filePath.lastIndexOf("/")
  if (idx <= 0) return "."
  return filePath.slice(0, idx)
}

const extractApplyPatchPaths = (patchText: string): string[] => {
  if (!patchText.trim()) return []
  const paths: string[] = []
  const lines = patchText.split("\n")

  for (const line of lines) {
    if (line.startsWith("*** Update File: ")) {
      paths.push(line.slice("*** Update File: ".length).trim())
    } else if (line.startsWith("*** Add File: ")) {
      paths.push(line.slice("*** Add File: ".length).trim())
    } else if (line.startsWith("*** Delete File: ")) {
      paths.push(line.slice("*** Delete File: ".length).trim())
    }
  }

  return paths
}

export const EditorDiffPlugin: Plugin = async ({ $ }) => {
  const getEnv = () =>
    (globalThis as { process?: { env?: Record<string, string>; platform?: string } })?.process

  const getPlatform = () => getEnv()?.platform || "linux"
  const isWindowsPlatform = () => getPlatform() === "win32"

  const getResolvedOS = (): DiffOS => {
    if (DIFF_CONFIG?.os) return DIFF_CONFIG.os
    return isWindowsPlatform() ? "windows" : "linux"
  }

  const getNullDevice = (): string => {
    return getResolvedOS() === "windows" ? "NUL" : "/dev/null"
  }

  const getHomeDir = () => {
    const env = getEnv()?.env
    return (env?.HOME || env?.USERPROFILE || "").trim()
  }

  const getDiffConfigPath = () => {
    const homeDir = getHomeDir()
    if (!homeDir) return ""
    return `${homeDir}/.config/opencode/diff.jsonc`
  }

  const getDefaultBackupDir = (): string => {
    const homeDir = getHomeDir()
    if (!homeDir) return ""
    return `${homeDir}/.config/opencode/.tmp`
  }

  const stripJsonComments = (value: string) =>
    value
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "")
      .replace(/,\s*([}\]])/g, "$1")

  const loadDiffConfig = async (): Promise<void> => {
    if (configInitialized) return
    configInitialized = true

    const configPath = getDiffConfigPath()
    if (!configPath) return

    try {
      await $`test -f ${configPath}`.quiet()
      const result = await $`cat ${configPath}`.quiet()
      const rawConfig = result.stdout?.toString() || ""
      if (rawConfig.trim()) {
        const parsed = JSON.parse(stripJsonComments(rawConfig)) as DiffConfig
        DIFF_CONFIG = parsed
      }
    } catch {
      // Use defaults
    }
  }

  const getDiffCommandTemplate = (): string => {
    if (DIFF_COMMAND_TEMPLATE) return DIFF_COMMAND_TEMPLATE
    const editor = (DIFF_CONFIG?.editor || "code").trim().toLowerCase()
    const os = getResolvedOS()
    const binary = os === "windows" ? `${editor}.cmd` : editor
    DIFF_COMMAND_TEMPLATE = `${binary} --diff {old} {new}`
    return DIFF_COMMAND_TEMPLATE
  }

  const getProjectRoot = async (): Promise<string> => {
    if (!PROJECT_ROOT) {
      const result = await $`pwd`.quiet()
      PROJECT_ROOT = result.stdout?.toString().trim() || ""
    }
    return PROJECT_ROOT
  }

  const ensureBackupDir = async (): Promise<string> => {
    if (backupDirCreated && BACKUP_DIR) return BACKUP_DIR
    const backupDir = getDefaultBackupDir()
    if (!backupDir) return ""
    await $`mkdir -p ${backupDir}`.quiet()
    backupDirCreated = true
    BACKUP_DIR = backupDir
    return backupDir
  }

  const createBackupPath = (backupDir: string, filePath: string): string => {
    const fileName = getBackupFileName(filePath)
    return `${backupDir}/${fileName}`
  }

  const ensureParentDirExists = async (filePath: string): Promise<void> => {
    const parentDir = getParentDir(filePath)
    await $`mkdir -p ${parentDir}`.quiet()
  }

  const shellQuote = (value: string): string => `'${value.replace(/'/g, `'"'"'`)}'`

  const runDiffCommand = async (backupPath: string, currentPath: string): Promise<void> => {
    const template = getDiffCommandTemplate()
    const command = template
      .replace("{old}", shellQuote(backupPath))
      .replace("{new}", shellQuote(currentPath))
    const os = getResolvedOS()
    if (os === "windows") {
      await $`cmd /c ${command}`
    } else {
      await $`sh -c ${command}`
    }
  }

  const showDiffs = async (backups: BackupInfo[]): Promise<BackupInfo[]> => {
    const notShown: BackupInfo[] = []
    for (const info of backups) {
      try {
        await runDiffCommand(info.backupPath, info.currentPath)
      } catch {
        notShown.push(info)
      }
    }
    return notShown
  }

  const removeFileQuietly = async (filePath: string): Promise<void> => {
    try {
      await $`rm -f ${filePath}`.quiet()
    } catch {
      // Ignore
    }
  }

  const cleanupDiffFiles = async (backups: BackupInfo[]): Promise<void> => {
    if (backups.length === 0) return

    await new Promise(r => setTimeout(r, 500))

    for (const info of backups) {
      if (info.cleanupBackup) {
        await removeFileQuietly(info.backupPath)
      }
    }
  }

  const scheduleCleanup = (): void => {
    if (cleanupTimer) {
      clearTimeout(cleanupTimer)
    }

    cleanupTimer = setTimeout(async () => {
      cleanupTimer = null
      await cleanupShownBackupsIfReady()
    }, CLEANUP_GRACE_MS)
  }

  const queueShownBackupsForCleanup = (backups: BackupInfo[]): void => {
    if (backups.length === 0) return
    shownBackupsAwaitingCleanup.push(...backups)
    shownBackupsLastUpdatedAt = Date.now()
    scheduleCleanup()
  }

  const cleanupShownBackupsIfReady = async (): Promise<void> => {
    if (shownBackupsAwaitingCleanup.length === 0) return
    if (Date.now() - shownBackupsLastUpdatedAt < CLEANUP_GRACE_MS) return

    const backups = shownBackupsAwaitingCleanup
    shownBackupsAwaitingCleanup = []
    await cleanupDiffFiles(backups)

    if (pendingBackupsByFile.size === 0 && activeSnapshotsStack.length === 0) {
      await resetBackupState()
    }
  }

  const resetBackupState = async (): Promise<void> => {
    pendingBackupsByFile = new Map()
    shownBackupsAwaitingCleanup = []
    activeSnapshotsStack = []
    backupDirCreated = false
    backupSequence = 0
    shownBackupsLastUpdatedAt = 0
    if (cleanupTimer) {
      clearTimeout(cleanupTimer)
      cleanupTimer = null
    }
    BACKUP_DIR = ""
  }

  const flushBackups = async (backups: BackupInfo[]): Promise<void> => {
    if (backups.length === 0) return

    const failedBackups = await showDiffs(backups)
    const shownBackups = backups.filter(info => !failedBackups.includes(info))
    queueShownBackupsForCleanup(shownBackups)

    for (const failed of failedBackups) {
      pendingBackupsByFile.set(failed.fileKey, failed)
    }
  }

  const flushBackupsExcept = async (activeFileKeys: Set<string>): Promise<void> => {
    const toFlush: BackupInfo[] = []

    for (const [fileKey, backup] of pendingBackupsByFile.entries()) {
      if (activeFileKeys.has(fileKey)) continue
      toFlush.push(backup)
      pendingBackupsByFile.delete(fileKey)
    }

    await flushBackups(toFlush)
  }

  const flushAllBackups = async (): Promise<void> => {
    const toFlush = Array.from(pendingBackupsByFile.values())
    pendingBackupsByFile = new Map()
    await flushBackups(toFlush)
  }

  const mergeBackup = async (nextBackup: BackupInfo): Promise<void> => {
    const existing = pendingBackupsByFile.get(nextBackup.fileKey)
    if (!existing) {
      pendingBackupsByFile.set(nextBackup.fileKey, nextBackup)
      return
    }

    if (nextBackup.cleanupBackup) {
      await removeFileQuietly(nextBackup.backupPath)
    }

    existing.currentPath = nextBackup.currentPath
  }

  const showRemainingDiffsAndCleanup = async (): Promise<void> => {
    await flushAllBackups()
    if (pendingBackupsByFile.size > 0) return

    await cleanupShownBackupsIfReady()
  }

  const fileExists = async (filePath: string): Promise<boolean> => {
    try {
      await $`test -f ${filePath}`.quiet()
      return true
    } catch {
      return false
    }
  }

  const collectToolFilePaths = (tool: string, args: any): Array<{ originalPath: string; normalizedPath: string }> => {
    const targets: Array<{ originalPath: string; normalizedPath: string }> = []
    const seen = new Set<string>()

    const addPath = (filePath: unknown) => {
      if (typeof filePath !== "string" || !filePath) return
      const normalizedPath = normalizePathToKey(filePath)
      if (seen.has(normalizedPath)) return
      seen.add(normalizedPath)
      targets.push({ originalPath: filePath, normalizedPath })
    }

    if (tool === "apply_patch") {
      const patchText = args.patchText
      if (typeof patchText !== "string") return targets
      for (const filePath of extractApplyPatchPaths(patchText)) {
        addPath(filePath)
      }
      return targets
    }

    if (tool === "multiedit") {
      const edits = args.edits
      if (!Array.isArray(edits)) return targets
      for (const edit of edits) {
        addPath(edit?.file_path)
      }
      return targets
    }

    addPath(args.file_path || args.filePath)
    return targets
  }

  const capturePreEditSnapshots = async (
    targets: Array<{ originalPath: string; normalizedPath: string }>,
    backupDir: string,
  ): Promise<PreEditSnapshot[]> => {
    const snapshots: PreEditSnapshot[] = []

    for (const target of targets) {
      const existing = pendingBackupsByFile.get(target.normalizedPath)
      if (existing) {
        snapshots.push({
          originalPath: target.originalPath,
          normalizedPath: target.normalizedPath,
          backupPath: existing.backupPath,
          cleanupBackup: false,
        })
        continue
      }

      const existsBefore = await fileExists(target.originalPath)
      if (!existsBefore) {
        snapshots.push({
          originalPath: target.originalPath,
          normalizedPath: target.normalizedPath,
          backupPath: getNullDevice(),
          cleanupBackup: false,
        })
        continue
      }

      const backupPath = createBackupPath(backupDir, target.normalizedPath)
      try {
        await ensureParentDirExists(backupPath)
        await $`cp ${target.originalPath} ${backupPath}`.quiet()
        snapshots.push({
          originalPath: target.originalPath,
          normalizedPath: target.normalizedPath,
          backupPath,
          cleanupBackup: true,
        })
      } catch {
        // Ignore backup failure for this file
      }
    }

    return snapshots
  }

  const capturePostEditDiffs = async (snapshots: PreEditSnapshot[]): Promise<BackupInfo[]> => {
    const backups: BackupInfo[] = []
    for (const snapshot of snapshots) {
      const existsAfter = await fileExists(snapshot.originalPath)
      const currentPath = existsAfter ? snapshot.originalPath : getNullDevice()

      backups.push({
        fileKey: snapshot.normalizedPath,
        backupPath: snapshot.backupPath,
        currentPath,
        cleanupBackup: snapshot.cleanupBackup,
      })
    }

    return backups
  }

  await loadDiffConfig()
  await getProjectRoot()

  return {
    event: async ({ event }) => {
      if (pendingBackupsByFile.size === 0) return

      if (event.type === "session.status") {
        const status = (event as any).properties?.status
        if (status?.type === "idle") {
          await showRemainingDiffsAndCleanup()
        }
      } else if (event.type === "session.idle") {
        await showRemainingDiffsAndCleanup()
      }
    },

    "tool.execute.before": async (input, output) => {
      const tool = input.tool
      if (tool !== "edit" && tool !== "write" && tool !== "multiedit" && tool !== "apply_patch") {
        return
      }

      const args = (input as any).args || output?.args || {}
      const targets = collectToolFilePaths(tool, args)
      if (targets.length === 0) {
        return
      }

      const targetFileKeys = new Set(targets.map(target => target.normalizedPath))
      await flushBackupsExcept(targetFileKeys)

      const backupDir = await ensureBackupDir()
      if (!backupDir) {
        return
      }

      const snapshots = await capturePreEditSnapshots(targets, backupDir)
      activeSnapshotsStack.push(snapshots)
    },

    "tool.execute.after": async () => {
      const snapshots = activeSnapshotsStack.pop()
      if (!snapshots || snapshots.length === 0) return

      const backupDir = await ensureBackupDir()
      if (!backupDir) return

      const newBackups = await capturePostEditDiffs(snapshots)
      if (newBackups.length === 0) return

      for (const backup of newBackups) {
        await mergeBackup(backup)
      }
    },
  }
}

export default EditorDiffPlugin
