import type { Plugin } from "@opencode-ai/plugin"

type DiffEditor = "code" | "cursor" | "antigravity" | "windsurf"
type DiffOS = "windows" | "linux"

interface DiffConfig {
  editor?: DiffEditor
  os?: DiffOS
}

interface BackupInfo {
  originalPath: string
  backupPath: string
  shown: boolean
  isNewFile: boolean
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
let pendingBackups: Map<string, BackupInfo> = new Map()
let lastEditedFile = ""
let backupDirCreated = false

const getFileName = (filePath: string): string => {
  const normalized = filePath.replace(/\\/g, "/")
  return normalized.split("/").pop() || "backup"
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
    const editor = DIFF_CONFIG?.editor || "code"
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

  const runDiffCommand = async (backupPath: string, originalPath: string): Promise<void> => {
    const template = getDiffCommandTemplate()
    const command = template.replace("{old}", backupPath).replace("{new}", originalPath)
    const os = getResolvedOS()
    if (os === "windows") {
      await $`cmd /c ${command}`
    } else {
      await $`sh -c ${command}`
    }
  }

  const showDiffForFile = async (fileName: string): Promise<void> => {
    const info = pendingBackups.get(fileName)
    if (!info || info.shown) return

    try {
      if (info.isNewFile) {
        await runDiffCommand(getNullDevice(), info.originalPath)
      } else if (info.backupPath) {
        await runDiffCommand(info.backupPath, info.originalPath)
      }
      info.shown = true
    } catch {
      // Ignore
    }
  }

const cleanupAllBackups = async (): Promise<void> => {
  for (const [_fileName, info] of pendingBackups) {
    if (info.backupPath && !info.isNewFile) {
      try {
        await $`rm -f ${info.backupPath}`.quiet()
      } catch {
        // Ignore
      }
    }
  }

  try {
    if (BACKUP_DIR) {
      await $`rm -rf ${BACKUP_DIR}`.quiet()
    }
  } catch {
    // Ignore
  }

  pendingBackups.clear()
  lastEditedFile = ""
  backupDirCreated = false
  BACKUP_DIR = ""
}

  const showRemainingDiffsAndCleanup = async (): Promise<void> => {
    for (const [fileName, info] of pendingBackups) {
      if (!info.shown) {
        await showDiffForFile(fileName)
      }
    }
    // Delay cleanup to let editor open diff
    await new Promise(r => setTimeout(r, 500))
    await cleanupAllBackups()
  }

  const fileExists = async (filePath: string): Promise<boolean> => {
    try {
      await $`test -f ${filePath}`.quiet()
      return true
    } catch {
      return false
    }
  }

  // Load config once at startup
  await loadDiffConfig()

  return {
    event: async ({ event }) => {
      if (pendingBackups.size === 0) return
      
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
      if (tool !== "edit" && tool !== "write" && tool !== "multiedit" && tool !== "patch") return

      const args = (input as any).args || output?.args || {}

      if (tool === "multiedit") {
        const edits = args.edits
        if (!Array.isArray(edits)) return

        const backupDir = await ensureBackupDir()
        if (!backupDir) return

        for (const edit of edits) {
          const filePath = edit?.file_path
          if (!filePath || typeof filePath !== "string") continue

          const fileName = getFileName(filePath)

          if (lastEditedFile && lastEditedFile !== fileName) {
            await showDiffForFile(lastEditedFile)
          }

          if (!pendingBackups.has(fileName)) {
            const exists = await fileExists(filePath)
            if (exists) {
              const backupPath = `${backupDir}/${fileName}`
              try {
                await $`cp ${filePath} ${backupPath}`.quiet()
                pendingBackups.set(fileName, { originalPath: filePath, backupPath, shown: false, isNewFile: false })
              } catch {
                // Ignore backup failure
              }
            } else {
              pendingBackups.set(fileName, { originalPath: filePath, backupPath: "", shown: false, isNewFile: true })
            }
          }

          lastEditedFile = fileName
        }
        return
      }

      const filePath = args.file_path || args.filePath
      if (!filePath || typeof filePath !== "string") return

      const fileName = getFileName(filePath)

      if (lastEditedFile && lastEditedFile !== fileName) {
        await showDiffForFile(lastEditedFile)
      }

      if (!pendingBackups.has(fileName)) {
        const backupDir = await ensureBackupDir()
        if (!backupDir) return

        const exists = await fileExists(filePath)
        if (exists) {
          const backupPath = `${backupDir}/${fileName}`
          try {
            await $`cp ${filePath} ${backupPath}`.quiet()
            pendingBackups.set(fileName, { originalPath: filePath, backupPath, shown: false, isNewFile: false })
          } catch {
            // Ignore backup failure
          }
        } else {
          pendingBackups.set(fileName, { originalPath: filePath, backupPath: "", shown: false, isNewFile: true })
        }
      }

      lastEditedFile = fileName
    },

    "tool.execute.after": async () => {},
  }
}

export default EditorDiffPlugin
