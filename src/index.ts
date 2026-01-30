import type { Plugin } from "@opencode-ai/plugin"

interface EditedFile {
  filePath: string
  backupPath: string
  isNew: boolean
}

type DiffEditor = "code" | "cursor" | "antigravity" | "windsurf"
type DiffOS = "windows" | "linux"

interface DiffConfig {
  editor?: DiffEditor
  os?: DiffOS
}

const DEFAULT_CONFIG_CONTENT = `{
  // Supported editors: "code", "cursor", "antigravity", "windsurf"
  "editor": "code",
  // Supported OS: "windows", "linux"
  "os": "linux"
}
`

let editedFiles: EditedFile[] = []
let pendingChanges = false
let PROJECT_ROOT = ""
let lastEditFilePath = ""
let DIFF_COMMAND_TEMPLATE = ""
let DIFF_CONFIG: DiffConfig | null = null
let configInitialized = false

const getFileName = (filePath: string): string => {
  const normalized = filePath.replace(/\\/g, "/")
  return normalized.split("/").pop() || "backup"
}

export const EditorDiffPlugin: Plugin = async ({ $ }) => {
  const getEnv = () =>
    (globalThis as { process?: { env?: Record<string, string>; platform?: string } })?.process

  const getPlatform = () => getEnv()?.platform || "linux"
  const isWindowsPlatform = () => getPlatform() === "win32"

  const getResolvedOS = async (): Promise<DiffOS> => {
    const config = await loadDiffConfig()
    if (config?.os) return config.os
    return isWindowsPlatform() ? "windows" : "linux"
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

  const stripJsonComments = (value: string) =>
    value
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "")
      .replace(/,\s*([}\]])/g, "$1")

  const ensureConfigExists = async (): Promise<void> => {
    if (configInitialized) return
    configInitialized = true

    const configPath = getDiffConfigPath()
    if (!configPath) return

    try {
      await $`test -f ${configPath}`.quiet()
    } catch {
      const homeDir = getHomeDir()
      if (homeDir) {
        try {
          await $`mkdir -p ${homeDir}/.config/opencode`.quiet()
          await $`echo ${DEFAULT_CONFIG_CONTENT} > ${configPath}`.quiet()
        } catch {
          // Could not create config
        }
      }
    }
  }

  const loadDiffConfig = async (): Promise<DiffConfig | null> => {
    if (DIFF_CONFIG !== null) return DIFF_CONFIG

    await ensureConfigExists()

    const configPath = getDiffConfigPath()
    if (!configPath) {
      DIFF_CONFIG = null
      return DIFF_CONFIG
    }

    try {
      const result = await $`cat ${configPath}`.quiet()
      const rawConfig = result.stdout?.toString() || ""
      if (!rawConfig.trim()) {
        DIFF_CONFIG = null
        return DIFF_CONFIG
      }
      const parsed = JSON.parse(stripJsonComments(rawConfig)) as DiffConfig
      const validEditors: DiffEditor[] = ["code", "cursor", "antigravity", "windsurf"]
      const validOS: DiffOS[] = ["windows", "linux"]
      if (parsed.editor && !validEditors.includes(parsed.editor)) {
        throw new Error(`Unsupported editor: "${parsed.editor}". Supported: code, cursor, antigravity, windsurf`)
      }
      if (parsed.os && !validOS.includes(parsed.os)) {
        throw new Error(`Unsupported OS: "${parsed.os}". Supported: windows, linux`)
      }
      DIFF_CONFIG = parsed
      return DIFF_CONFIG
    } catch {
      DIFF_CONFIG = null
      return DIFF_CONFIG
    }
  }

  const getDefaultCommandTemplate = (editor: DiffEditor, os: DiffOS) => {
    const binary = os === "windows" ? `${editor}.cmd` : editor
    return `${binary} --diff {old} {new}`
  }

  const getDiffCommandTemplate = async () => {
    if (DIFF_COMMAND_TEMPLATE) return DIFF_COMMAND_TEMPLATE

    const config = await loadDiffConfig()
    const editor = config?.editor || "code"
    const os = await getResolvedOS()
    DIFF_COMMAND_TEMPLATE = getDefaultCommandTemplate(editor, os)
    return DIFF_COMMAND_TEMPLATE
  }

  const getProjectRoot = async () => {
    if (!PROJECT_ROOT) {
      const result = await $`pwd`.quiet()
      PROJECT_ROOT = result.stdout?.toString().trim() || ""
    }
    return PROJECT_ROOT
  }

  const createBackupDir = async (root: string) => {
    if (root) {
      await $`mkdir -p ${root}/.tmp`.quiet()
    }
  }

  const getNullPath = (os: DiffOS) => (os === "windows" ? "NUL" : "/dev/null")

  const buildCommand = (template: string, oldPath: string, newPath: string) =>
    template.replaceAll("{old}", oldPath).replaceAll("{new}", newPath)

  const runDiffCommand = async (command: string, os: DiffOS) => {
    if (os === "windows") {
      await $`cmd /c ${command}`
      return
    }
    await $`bash -lc ${command}`
  }

  const showDiffsAndCleanup = async () => {
    if (editedFiles.length === 0) {
      const root = await getProjectRoot()
      if (root) {
        try {
          await $`rmdir ${root}/.tmp`.quiet()
        } catch {
          // Not empty or doesn't exist
        }
      }
      return
    }

    await new Promise((r) => setTimeout(r, 100))
    const diffCommandTemplate = await getDiffCommandTemplate()
    const os = await getResolvedOS()
    const root = await getProjectRoot()
    const backupsToRemove: string[] = []
    const nullPath = getNullPath(os)

    for (const file of editedFiles) {
      if (file.isNew && os === "windows") continue
      try {
        const oldPath = file.isNew ? nullPath : file.backupPath || nullPath
        const command = buildCommand(diffCommandTemplate, oldPath, file.filePath)
        await runDiffCommand(command, os)
        if (!file.isNew && root && file.backupPath) {
          backupsToRemove.push(file.backupPath)
        }
      } catch {
        // Continue to next file
      }
    }

    if (root && backupsToRemove.length > 0) {
      setTimeout(async () => {
        for (const backupPath of backupsToRemove) {
          try {
            await $`rm -f ${backupPath}`.quiet()
          } catch {
            // Ignore
          }
        }
        try {
          await $`rmdir ${root}/.tmp`.quiet()
        } catch {
          // Not empty
        }
      }, 1000)
    }

    editedFiles = []
    pendingChanges = false
  }

  return {
    "tool.execute.before": async (input, output) => {
      const tool = input.tool
      const args = (input as any).args || output?.args || {}

      const isEdit = tool === "edit"
      const isWrite = tool === "write"
      const isMultiEdit = tool === "multiedit"
      const isPatch = tool === "patch"

      if (isEdit || isWrite || isPatch) {
        const filePath = args.file_path || args.filePath
        if (filePath && typeof filePath === "string") {
          lastEditFilePath = filePath
          const root = await getProjectRoot()
          const fileName = getFileName(filePath)
          const backupPath = root ? `${root}/.tmp/${fileName}` : ""

          await createBackupDir(root)

          if (isWrite) {
            try {
              await $`cp ${filePath} ${backupPath}`.quiet()
              editedFiles.push({ filePath, backupPath, isNew: false })
            } catch {
              editedFiles.push({ filePath, backupPath: "", isNew: true })
            }
            pendingChanges = true
          } else if ((isEdit || isPatch) && root) {
            try {
              await $`cp ${filePath} ${backupPath}`.quiet()
              editedFiles.push({ filePath, backupPath, isNew: false })
            } catch {
              editedFiles.push({ filePath, backupPath, isNew: false })
            }
            pendingChanges = true
          }
        }
      }

      if (isMultiEdit) {
        const edits = args.edits
        if (Array.isArray(edits)) {
          const root = await getProjectRoot()
          await createBackupDir(root)

          for (const edit of edits) {
            const filePath = edit?.file_path
            if (filePath && typeof filePath === "string" && root) {
              lastEditFilePath = filePath
              const fileName = getFileName(filePath)
              const backupPath = `${root}/.tmp/${fileName}`
              try {
                await $`cp ${filePath} ${backupPath}`.quiet()
                editedFiles.push({ filePath, backupPath, isNew: false })
                pendingChanges = true
              } catch {
                // Ignore
              }
            }
          }
        }
      }
    },

    "tool.execute.after": async (_input, _output) => {
      if (pendingChanges) {
        if (lastEditFilePath) {
          editedFiles = editedFiles.filter((file) => file.filePath === lastEditFilePath)
        }
        await showDiffsAndCleanup()
        lastEditFilePath = ""
      }
    },
  }
}

export default EditorDiffPlugin
