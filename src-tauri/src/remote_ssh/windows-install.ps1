try {
    $dir = Agent-Dir $true
    $agent = "$dir\twiglane-agent-v2-$digest.exe"
    $pin = "$dir\current.sha256"
    $id = [Guid]::NewGuid().ToString('N')
    $tmp = "$dir\$id.tmp"
    $next = "$dir\$id.pin"
    $s = [IO.File]::Open($tmp,'CreateNew','Write','None')
    try { [Console]::OpenStandardInput().CopyTo($s) } finally { $s.Dispose() }
    if ((Get-Sha256 $tmp) -cne $digest) { throw 'agent_digest_mismatch' }
    if (![IO.File]::Exists($agent)) {
        [IO.File]::Move($tmp,$agent)
    } elseif ((Get-Sha256 $agent) -cne $digest) {
        [IO.File]::Replace($tmp,$agent,[NullString]::Value)
    }
    [IO.File]::WriteAllText($next,$digest,[Text.Encoding]::ASCII)
    if ([IO.File]::Exists($pin)) {
        Protect-Path $pin
        [IO.File]::Replace($next,$pin,[NullString]::Value)
    } else {
        [IO.File]::Move($next,$pin)
    }
    [Console]::WriteLine(('{{"installed":true,"agentSha256":"{0}"}}' -f $digest))
    exit 0
} catch {
    Agent-Error $_ 'agent_install_failed'
    exit 1
} finally {
    foreach ($file in $tmp,$next) {
        if ($file) { [IO.File]::Delete($file) }
    }
}
