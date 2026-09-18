#!/bin/sh
# ============================================================================
# Aggiorna in un colpo solo versione, data e numero di cache.
#
#   ./version.sh 4.3          → intro "4.3 <ggmm di oggi>", cache +1
#   ./version.sh 4.3 1809     → data forzata
#
# Toccare i tre punti a mano era la via più facile per dimenticarne uno e
# ritrovarsi con l'iPhone che serve la versione vecchia.
# ============================================================================
set -e
cd "$(dirname "$0")"

VER="${1:?uso: ./version.sh <versione> [ggmm]}"
DATA="${2:-$(date +%d%m)}"

# numero di cache: quello attuale più uno
CUR=$(sed -n "s/.*palestra50-v\([0-9]*\).*/\1/p" sw.js | head -1)
NEXT=$((CUR + 1))

sed -i.bak "s|<div class=\"ver num\">[^<]*</div>|<div class=\"ver num\">$VER $DATA</div>|" index.html
sed -i.bak "s|palestra50-v$CUR|palestra50-v$NEXT|" sw.js
rm -f index.html.bak sw.js.bak

echo "intro:  $VER $DATA"
echo "cache:  palestra50-v$NEXT (era v$CUR)"
