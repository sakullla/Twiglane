try {
    [Console]::WriteLine('system=Windows')
    $architecture = $env:PROCESSOR_ARCHITEW6432
    if (!$architecture) { $architecture = $env:PROCESSOR_ARCHITECTURE }
    [Console]::WriteLine("architecture=$architecture")
    if (Get-Command git.exe -ErrorAction SilentlyContinue) {
        $git = & git.exe --version
        if ($LASTEXITCODE -eq 0) { [Console]::WriteLine("git=$git") }
    }
    $dir = Agent-Dir $false
    if ($dir) {
        $pointer = "$dir\current.sha256"
        if ([IO.File]::Exists($pointer)) {
            Protect-Path $pointer
            if ([IO.FileInfo]::new($pointer).Length -eq 64) {
                $digest = [IO.File]::ReadAllText($pointer)
                if ($digest -cmatch '\A[0-9a-f]{64}\z') {
                    $agent = "$dir\twiglane-agent-v2-$digest.exe"
                    if ([IO.File]::Exists($agent) -and (Get-Sha256 $agent) -ceq $digest) {
                        [Console]::WriteLine("digest=$digest")
                        $probe = & $agent --probe
                        if ($LASTEXITCODE -eq 0) { [Console]::WriteLine('probe=' + ($probe -join ' ')) }
                    }
                }
            }
        }
    }
    exit 0
} catch {
    Agent-Error $_ 'agent_probe_failed'
    exit 1
}
