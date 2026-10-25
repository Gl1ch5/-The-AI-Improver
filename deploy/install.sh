#!/usr/bin/env bash
# Установка на Ubuntu/Debian как systemd-сервис. Запуск: sudo bash deploy/install.sh
set -euo pipefail
DIR=/opt/ai-improver
id aiimprover &>/dev/null || useradd --system --home "$DIR" --shell /usr/sbin/nologin aiimprover
mkdir -p "$DIR/data"
cp -r package.json server public "$DIR/"
[ -f "$DIR/.env" ] || cp .env.example "$DIR/.env"
chown -R aiimprover:aiimprover "$DIR/data"
chmod 600 "$DIR/.env"
cp deploy/ai-improver.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now ai-improver
systemctl restart ai-improver
echo "Готово. Проверка: curl http://127.0.0.1:\$(grep ^PORT $DIR/.env | cut -d= -f2)/health"
