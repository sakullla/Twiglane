try {
    $dir = Agent-Dir $false
    if (!$dir) { throw 'agent_missing' }
    $agent = "$dir\twiglane-agent-v2-$digest.exe"
    if (![IO.File]::Exists($agent)) { throw 'agent_missing' }
    if ((Get-Sha256 $agent) -cne $digest) { throw 'agent_digest_mismatch' }
    $command = [Diagnostics.ProcessStartInfo]::new()
    $command.FileName = $agent
    $command.Arguments = '--stdio'
    $command.UseShellExecute = $false
    $process = [Diagnostics.Process]::Start($command)
    try {
        $process.WaitForExit()
        exit $process.ExitCode
    } finally { $process.Dispose() }
} catch {
    Agent-Error $_ 'agent_start_failed'
    exit 1
}
