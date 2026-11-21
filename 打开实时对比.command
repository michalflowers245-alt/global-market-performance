#!/bin/zsh
set -eu
cd -- "${0:A:h}"
py="$(command -v python3 || true)"
if [[ -z "$py" && -x /opt/homebrew/bin/python3 ]]; then py=/opt/homebrew/bin/python3; fi
if [[ -z "$py" ]]; then
  print '需要本机 Python 3。'
  read -r 'reply?按回车关闭。'
  exit 1
fi
market_url=http://127.0.0.1:8769
health() { [[ "$(curl -fsS --max-time 2 "$market_url/health" 2>/dev/null)" == global-market-chart ]]; }
if ! health; then
  "$py" market_server.py --serve </dev/null >>.market-server.log 2>&1 &!
  for _ in {1..30}; do
    if health; then break; fi
    sleep .25
  done
fi
if ! health; then
  print '本机行情页面启动失败。'
  tail -12 .market-server.log 2>/dev/null || true
  read -r 'reply?按回车关闭。'
  exit 1
fi
open "$market_url/"
