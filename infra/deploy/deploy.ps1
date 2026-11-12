<#
.SYNOPSIS
  从 Windows 把当前仓库部署到一台 Linux 云主机（阿里云 ECS / 腾讯云 / 任意 VPS）。

.DESCRIPTION
  做的事：把当前 git HEAD 打包（不依赖是否已 push）→ 上传源码包与部署脚本 → 在服务器上执行
  bootstrap.sh（装 Node 24 + Caddy、建 systemd 服务、渲染 Caddyfile、开防火墙）→ 回来验证公网入口。

  bootstrap.sh 不挑发行版：Ubuntu / Debian / Alibaba Cloud Linux / Anolis / CentOS Stream /
  Rocky / AlmaLinux / openEuler 都能跑（apt 与 dnf 两条路径）。

.PARAMETER Preflight
  只做体检：打印系统、资源、已有组件、端口占用、出网情况，不修改服务器任何东西。

.PARAMETER TunnelToken
  Cloudflare Tunnel 的 token（面板 → Networks → Tunnels → 该隧道 → 安装命令里的 --token 值）。
  用于**没有已备案域名**的大陆 ECS：全程不需要入站 80/443，也就绕开备案与端口拦截。

.EXAMPLE
  .\deploy.ps1 -Server 1.2.3.4 -Preflight

.EXAMPLE
  .\deploy.ps1 -Server 1.2.3.4

.EXAMPLE
  .\deploy.ps1 -Server 1.2.3.4 -Domain sync.example.com

.EXAMPLE
  # 没有域名、也不想注册 Cloudflare 账号：Quick Tunnel（地址每次重启会变）
  .\deploy.ps1 -Server 1.2.3.4 -QuickTunnel

.EXAMPLE
  .\deploy.ps1 -Server 1.2.3.4 -TunnelToken eyJhIjoi...

.EXAMPLE
  .\deploy.ps1 -Server 1.2.3.4 -User ubuntu -IdentityFile $env:USERPROFILE\.ssh\id_ed25519
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$Server,
  [string]$User = "root",
  [string]$Domain = "",
  [int]$Port = 1234,
  [string]$IdentityFile = "",
  [string]$RepoRoot = "",
  [string]$TunnelToken = "",
  [switch]$QuickTunnel,
  [switch]$Preflight,
  [switch]$SkipVerify
)

$ErrorActionPreference = "Stop"

if (-not $RepoRoot) {
  $RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
}
$bootstrap = Join-Path $PSScriptRoot "bootstrap.sh"
foreach ($required in @($bootstrap, (Join-Path $RepoRoot ".git"))) {
  if (-not (Test-Path $required)) { throw "找不到必需的路径：$required" }
}

$sshTarget = "$User@$Server"
$baseArgs = @("-o", "StrictHostKeyChecking=accept-new", "-o", "ServerAliveInterval=15", "-o", "ConnectTimeout=20")
$scpArgs = @("-o", "StrictHostKeyChecking=accept-new", "-o", "ConnectTimeout=20")
if ($IdentityFile) {
  $baseArgs += @("-i", $IdentityFile)
  $scpArgs += @("-i", $IdentityFile)
}

# ---------------------------------------------------------------- 预检
if ($Preflight) {
  Write-Host "== 预检 $sshTarget（只读，不修改服务器）" -ForegroundColor Cyan
  $probe = @(
    'set -u'
    'echo "--- 身份 ---"; id -un; id -u'
    'echo "--- 系统 ---"; . /etc/os-release 2>/dev/null && echo "PRETTY=$PRETTY_NAME"; echo "ID=${ID:-unknown}"; uname -m; uname -r'
    'echo "--- 资源 ---"; free -m | head -2; df -h / | tail -1; echo "CPU=$(nproc)"'
    'echo "--- 组件 ---"; for c in node npm caddy cloudflared curl git ufw firewall-cmd; do printf "%-13s %s\n" "$c" "$(command -v $c || echo -)"; done'
    'echo "--- Node ---"; node -v 2>/dev/null || echo "无"'
    'echo "--- 端口 80/443/1234 ---"; (ss -ltn 2>/dev/null || netstat -ltn 2>/dev/null) | grep -E ":(80|443|1234)\b" || echo "空闲"'
    'echo "--- 出网 ---"; for u in https://nodejs.org/dist/latest-v24.x/SHASUMS256.txt https://github.com https://ubuntu.com; do printf "%-60s %s\n" "$u" "$(curl -s -o /dev/null -w "%{http_code}" --max-time 8 "$u" || echo fail)"; done'
    'echo "--- SELinux ---"; command -v getenforce >/dev/null && getenforce || echo "无"'
  ) -join "`n"
  $probeFile = Join-Path ([System.IO.Path]::GetTempPath()) ("relay-preflight-" + (Get-Date -Format "HHmmss") + ".sh")
  Set-Content -Path $probeFile -Value $probe -Encoding utf8
  try {
    & scp @scpArgs $probeFile "${sshTarget}:/tmp/relay-preflight.sh"
    if ($LASTEXITCODE -ne 0) { throw "上传预检脚本失败：检查 IP、用户、密钥/密码、安全组 22 端口" }
    & ssh @baseArgs $sshTarget "bash /tmp/relay-preflight.sh; rm -f /tmp/relay-preflight.sh"
  } finally {
    Remove-Item $probeFile -ErrorAction SilentlyContinue
  }
  return
}

# ---------------------------------------------------------------- 打包
Write-Host "== 1/5 打包当前 HEAD（不含 node_modules / .artifacts）" -ForegroundColor Cyan
$archive = Join-Path ([System.IO.Path]::GetTempPath()) ("folder-relay-" + (Get-Date -Format "yyyyMMdd-HHmmss") + ".tar.gz")
Push-Location $RepoRoot
try {
  git archive --format=tar.gz -o $archive HEAD
  if ($LASTEXITCODE -ne 0) { throw "git archive 失败" }
  Write-Host ("   打包完成：{0}（{1} KB）" -f $archive, [math]::Round((Get-Item $archive).Length / 1KB, 1))
} finally {
  Pop-Location
}

# ---------------------------------------------------------------- 上传
Write-Host "== 2/5 上传源码包" -ForegroundColor Cyan
& scp @scpArgs $archive "${sshTarget}:/tmp/folder-relay.tar.gz"
if ($LASTEXITCODE -ne 0) { throw "scp 失败：检查 IP、用户、密钥/密码与安全组 22" }

Write-Host "== 3/5 上传部署脚本" -ForegroundColor Cyan
& scp @scpArgs $bootstrap "${sshTarget}:/tmp/bootstrap.sh"
if ($LASTEXITCODE -ne 0) { throw "scp bootstrap.sh 失败" }

# ---------------------------------------------------------------- 远程执行
Write-Host "== 4/5 在服务器上安装与启动（首次约 2-4 分钟）" -ForegroundColor Cyan
$remote = "bash /tmp/bootstrap.sh --source /tmp/folder-relay.tar.gz --port $Port"
if ($Domain) { $remote += " --domain $Domain" }
if ($TunnelToken) { $remote += " --tunnel-token $TunnelToken" }
if ($QuickTunnel) { $remote += " --quick-tunnel" }
& ssh @baseArgs $sshTarget $remote
if ($LASTEXITCODE -ne 0) { throw "远程部署失败，见上方输出" }

# ---------------------------------------------------------------- 验证
if (-not $SkipVerify) {
  Write-Host "== 5/5 从本机验证入口" -ForegroundColor Cyan
  if ($TunnelToken -or $QuickTunnel) {
    Write-Host "   隧道模式：公网域名由 Cloudflare 分配，跳过本机验证（远程自检已打印地址）" -ForegroundColor Yellow
    Write-Host "   在服务器上随时可查当前地址：relay-url" -ForegroundColor Yellow
  } else {
    $hostName = if ($Domain) { $Domain } else { "$Server.sslip.io" }
    foreach ($path in @("/healthz", "/v1/config")) {
      try {
        $response = Invoke-WebRequest -Uri ("https://" + $hostName + $path) -TimeoutSec 25 -UseBasicParsing
        Write-Host ("   {0,-14} -> {1}" -f $path, $response.StatusCode) -ForegroundColor Green
      } catch {
        $code = $_.Exception.Response.StatusCode.value__
        if ($code) { Write-Host ("   {0,-14} -> {1}" -f $path, $code) -ForegroundColor Yellow }
        else { Write-Host ("   {0,-14} -> 连不上：{1}" -f $path, $_.Exception.Message) -ForegroundColor Red }
      }
    }
    Write-Host ""
    Write-Host ("服务器地址：wss://{0}" -f $hostName) -ForegroundColor Green
  }
}

Remove-Item $archive -ErrorAction SilentlyContinue
