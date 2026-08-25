' Launches the watcher with Node.js and no visible console window.
' Used by the "ClaudeUsageWatcher" scheduled task (see install-task.ps1).
Set WshShell = CreateObject("WScript.Shell")
scriptDir = CreateObject("Scripting.FileSystemObject").GetParentFolderName(WScript.ScriptFullName)
nodeExe = "node.exe"
watcherPath = scriptDir & "\watcher.js"
WshShell.CurrentDirectory = scriptDir
WshShell.Run """" & nodeExe & """ """ & watcherPath & """", 0, False
