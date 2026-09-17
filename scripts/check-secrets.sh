#!/usr/bin/env bash
# scripts/check-secrets.sh — v2.38.1 (ревью F1/F2): защита от повторного коммита секретов.
#
# Сканит ТОЛЬКО трекаемые git-файлы (незатреканное gitignore уже покрывает):
#   1) трекаемые .env-файлы / файлы кредов;
#   2) трекаемые ключи/«таблички с паролями» (*.pem, *.key, *.p12, *.pfx, *.xlsx);
#   3) секрет-паттерны в тексте: AWS-ключи, приватные ключи, GitHub/Slack-токены,
#      длинные hex/base64-константы РЯДОМ с именами KEY/SECRET/TOKEN/PASSWORD.
#
# Инцидент-мотивация: D1_GATEWAY_SECRET был закоммичен в .env.production.local
# (коммит 25bd1bd), все прод-секреты — в «пазворты.xlsx» вне репо (F2).
# Ротация и вычистка истории: docs/SECURITY-ROTATION.md.
#
# Ложное срабатывание? Добавьте в конец строки маркер:  # public-placeholder
# (публично известные дефолты env.ts — fail-closed в проде — уже исключены
# паттернами: значения с дефисами/длиннее словарных слов не матчатся).
#
# Выход: 0 = чисто, 1 = найдено что-то подозрительное. Прерывать коммит:
#   pre-commit:  scripts/check-secrets.sh || exit 1
set -uo pipefail

cd "$(git rev-parse --show-toplevel 2>/dev/null || pwd)" || exit 1

fail=0
say_fail() { echo "SECRETS-CHECK FAIL: $1" >&2; fail=1; }

# --- 1. Трекаемые env-файлы (устранение F1: .env.production.local в 25bd1bd) ---
tracked_env=$(git ls-files -- '.env*' 'creds.env' '*.env.local' 2>/dev/null)
if [ -n "$tracked_env" ]; then
  say_fail "трекаются env-файлы (секреты в git!). git rm --cached <файл> и далее docs/SECURITY-ROTATION.md:
$tracked_env"
fi

# --- 2. Трекаемые ключи/секретные документы ---
tracked_keys=$(git ls-files -- '*.pem' '*.key' '*.p12' '*.pfx' '*.xlsx' '*.keystore' 2>/dev/null)
if [ -n "$tracked_keys" ]; then
  say_fail "трекаются файлы ключей/таблиц с кредами:
$tracked_keys"
fi

# --- 3. Паттерны в тексте трекаемых файлов ---
# grep -I пропускает бинарные файлы; git grep ищет только по трекаемым.
# Lockfile'ы исключены: integrity-хэши sha512 и имена пакетов вроде js-tokens
# дают ложные срабатывания, реальных секретов там не бывает.
LOCK_EXCL=(":!bun.lock" ":!package-lock.json" ":!bun.lockb")

pats=(
  'AKIA[0-9A-Z]{16}'                                        # AWS Access Key ID
  'BEGIN [A-Z ]*PRIVATE KEY'                                # PEM приватные ключи
  'ghp_[A-Za-z0-9]{36,}'                                    # GitHub PAT (classic)
  'github_pat_[A-Za-z0-9_]{30,}'                            # GitHub PAT (fine-grained)
  'xox[baprs]-[A-Za-z0-9-]{10,}'                            # Slack-токены
  'sk-[A-Za-z0-9]{32,}'                                     # OpenAI-style ключи
)

hits=$(git grep -I -n -E "${pats[@]}" -- . "${LOCK_EXCL[@]}" 2>/dev/null | grep -v '# *public-placeholder' || true)
if [ -n "$hits" ]; then
  say_fail "найдены паттерны секретных токенов/ключей:
$hits"
fi

# --- 4. Длинные hex/base64-константы в строках РЯДОМ с KEY/SECRET/TOKEN/PASSWORD ---
# Двухступенчато (ERE без lookbehind): сначала строки с секрет-именем
# (\b-границы: «js-tokens»/«loose-envify» НЕ матчатся, «GATEWAY_SECRET» — да),
# затем в них — константа ≥32 hex или ≥40 base64-символов (URL/lockfile-хэши
# не содержат секрет-имён на той же строке и не попадают).
secret_named=$(git grep -I -n -i -E '\b(API[_-]?KEY|[A-Za-z0-9_-]*(SECRET|TOKEN|PASSWORD)|PASSPHRASE)\b' -- . "${LOCK_EXCL[@]}" 2>/dev/null | grep -v '# *public-placeholder' || true)
if [ -n "$secret_named" ]; then
  suspicious=$(printf '%s\n' "$secret_named" | grep -E '(^|[^A-Za-z0-9+/])[A-Za-z0-9+/]{40,}($|[^A-Za-z0-9+/])|(^|[^0-9a-fA-F])[0-9a-fA-F]{32,}($|[^0-9a-fA-F])' || true)
  if [ -n "$suspicious" ]; then
    say_fail "длинные hex/base64-константы рядом с KEY/SECRET/TOKEN/PASSWORD (проверьте глазами:
это значение секрета или безопасный дефолт? если дефолт — маркер # public-placeholder):
$suspicious"
  fi
fi

if [ "$fail" -ne 0 ]; then
  echo "—" >&2
  echo "Ротация скомпрометированных секретов: docs/SECURITY-ROTATION.md" >&2
  exit 1
fi
echo "SECRETS-CHECK OK: трекаемых env-файлов/ключей и секрет-паттернов не найдено."
