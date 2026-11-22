$ErrorActionPreference = 'Stop'
$owners = @([Security.Principal.WindowsIdentity]::GetCurrent().User.Value,'S-1-5-18','S-1-5-32-544')

function Protect-Path($path) {
    if (([IO.File]::GetAttributes($path) -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw 'unsafe_install_directory'
    }
    $acl = [IO.File]::GetAccessControl($path)
    $sid = [Security.Principal.SecurityIdentifier]
    if ($acl.GetOwner($sid).Value -notin $owners) { throw 'unsafe_install_directory' }
    # Write, Delete, DeleteSubdirectoriesAndFiles, ChangePermissions, and TakeOwnership.
    foreach ($rule in $acl.GetAccessRules($true,$true,$sid)) {
        if ($rule.AccessControlType -eq 'Allow' -and ($rule.FileSystemRights -band 0xD0156) -and
            $rule.IdentityReference.Value -notin ($owners + 'S-1-3-4')) { throw 'unsafe_install_directory' }
    }
}

function Agent-Dir([bool]$create) {
    $dir = $env:LOCALAPPDATA
    Protect-Path $dir
    foreach ($part in 'Twiglane','agent','v2') {
        $dir = "$dir\$part"
        if (![IO.Directory]::Exists($dir)) {
            if (!$create) { return }
            $acl = [Security.AccessControl.DirectorySecurity]::new()
            $acl.SetAccessRuleProtection($true,$false)
            foreach ($owner in $owners) {
                $sid = [Security.Principal.SecurityIdentifier]::new($owner)
                $rule = [Security.AccessControl.FileSystemAccessRule]::new($sid,'FullControl','ContainerInherit,ObjectInherit','None','Allow')
                $acl.AddAccessRule($rule)
            }
            [void][IO.Directory]::CreateDirectory($dir,$acl)
        }
        Protect-Path $dir
    }
    $dir
}

function Get-Sha256($path) {
    Protect-Path $path
    $sha = [Security.Cryptography.SHA256]::Create()
    $s = [IO.File]::OpenRead($path)
    try { [BitConverter]::ToString($sha.ComputeHash($s)).Replace('-','').ToLowerInvariant() }
    finally { $s.Dispose(); $sha.Dispose() }
}

function Agent-Error($err,$fallback) {
    $reason = $err.Exception.Message
    if ($reason -notin 'unsafe_install_directory','agent_missing','agent_digest_mismatch') { $reason = $fallback }
    [Console]::Error.WriteLine($reason)
}
