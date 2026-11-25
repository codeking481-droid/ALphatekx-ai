import { config } from '../config.js'
import { registerFileListTool } from './file-list.js'
import { registerFileReadTool } from './file-read.js'
import { registerFileWriteTool } from './file-write.js'

export function registerFileTools(options = {}) {
  const workspaceDir = options.workspaceDir || config.workspaceDir
  const unregister = [
    registerFileListTool({ workspaceDir }),
    registerFileReadTool({ workspaceDir }),
    registerFileWriteTool({ workspaceDir }),
  ]
  return () => unregister.reverse().forEach((remove) => remove())
}
