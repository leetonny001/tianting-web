#!/usr/bin/env bash
# 给 tianting-web 的 CI 配置两把只读部署密钥（由仓库所有者本人运行）：
# tianting-sdk-ts（构建依赖的 SDK）和 tianting-server（端到端测试）。私钥只经过管道，不打印、不留在磁盘上。
set -euo pipefail
dir="$(mktemp -d)"
trap 'rm -rf "$dir"' EXIT
for repo in tianting-sdk-ts tianting-server; do
  name="$(echo "$repo" | tr 'a-z-' 'A-Z_' | sed 's/^TIANTING_//')"
  ssh-keygen -q -t ed25519 -N '' -C "tianting-web-ci-$repo" -f "$dir/$repo"
  gh repo deploy-key add "$dir/$repo.pub" -R "leetonny001/$repo" -t "tianting-web-ci"
  gh secret set "TIANTING_${name%%_TS}_DEPLOY_KEY" -R leetonny001/tianting-web < "$dir/$repo"
done
echo "完成：已为 tianting-sdk-ts、tianting-server 添加只读部署密钥，并设置 tianting-web 的两个 secret；本地密钥文件已删除。"
