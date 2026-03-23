#!/bin/bash
#
# Migracja formulopl z Heroku US do EU
#
# Wykonaj krok po kroku. Nie uruchamiaj calego skryptu naraz.
# Sprawdzaj output kazdego kroku przed przejsciem dalej.
#
# Cel: appka "formulopl" w regionie EU z domena formulo.pl

FINAL_NAME="formulopl"
TEMP_NAME="formulopl-tmp-eu"
TEAM="reasoning-org"

# ============================================================
# KROK 1: Eksport config vars ze starej appki
# ============================================================

heroku config -s -a $FINAL_NAME > /tmp/formulopl-config.env
echo "Config vars zapisane do /tmp/formulopl-config.env"

# ============================================================
# KROK 2: Eksport listy buildpackow
# ============================================================

heroku buildpacks -a $FINAL_NAME

# ============================================================
# KROK 3: Eksport drainow
# ============================================================

heroku drains -a $FINAL_NAME

# ============================================================
# KROK 4: Eksport domen
# ============================================================

heroku domains -a $FINAL_NAME

# ============================================================
# KROK 5: Utworz nowa appke w EU (tymczasowa nazwa)
# ============================================================

heroku apps:create $TEMP_NAME --region eu --team $TEAM

# ============================================================
# KROK 6: Buildpacki (ta sama kolejnosc jak w kroku 2)
# ============================================================

heroku buildpacks:add heroku/python -a $TEMP_NAME
heroku buildpacks:add heroku/nodejs -a $TEMP_NAME
heroku buildpacks:add https://github.com/DataDog/heroku-buildpack-datadog.git -a $TEMP_NAME

# Weryfikuj kolejnosc:
heroku buildpacks -a $TEMP_NAME

# ============================================================
# KROK 7: Import config vars
# ============================================================

cat /tmp/formulopl-config.env | tr '\n' ' ' | xargs heroku config:set -a $TEMP_NAME

# ============================================================
# KROK 8: Dodaj Datadog log drain (podmien DD_API_KEY)
# ============================================================

# Odczytaj klucz z config:
# heroku config:get DD_API_KEY -a $TEMP_NAME
#
# Dodaj drain (wstaw swoj klucz):
# heroku drains:add "https://http-intake.logs.datadoghq.eu/api/v2/logs?dd-api-key=TWOJ_KLUCZ&ddsource=heroku&service=formulo&host=formulopl" -a $TEMP_NAME

# ============================================================
# KROK 9: Deploy kodu
# ============================================================

# heroku git:remote -a $TEMP_NAME -r eu
# git push eu main

# Poczekaj na build i sprawdz logi:
# heroku logs --tail -a $TEMP_NAME

# ============================================================
# KROK 10: Weryfikacja (na tymczasowej domenie)
# ============================================================

# curl https://$TEMP_NAME.herokuapp.com/health
# heroku info -a $TEMP_NAME
#   => Region: eu

# ============================================================
# KROK 11: Zamiana appek
#
# To jest moment krotszego downtime (kilka sekund).
# Kolejnosc:
#   1. Usun domeny ze starej appki
#   2. Usun stara appke (zwalnia nazwe "formulopl")
#   3. Rename nowej na "formulopl"
#   4. Dodaj domeny do nowej appki
# ============================================================

# 11a. Usun domeny ze starej appki
# heroku domains:remove formulo.pl -a $FINAL_NAME
# heroku domains:remove www.formulo.pl -a $FINAL_NAME

# 11b. Usun stara appke (zwalnia nazwe)
# heroku apps:destroy $FINAL_NAME --confirm $FINAL_NAME

# 11c. Rename nowej na finalna nazwe
# heroku apps:rename $FINAL_NAME -a $TEMP_NAME

# 11d. Dodaj domeny
# heroku domains:add formulo.pl -a $FINAL_NAME
# heroku domains:add www.formulo.pl -a $FINAL_NAME

# 11e. Sprawdz nowy DNS target
# heroku domains -a $FINAL_NAME

# 11f. Jesli DNS target sie zmienil, zaktualizuj u rejestratora

# ============================================================
# KROK 12: Weryfikacja finalna
# ============================================================

# heroku info -a $FINAL_NAME
# curl https://formulo.pl/health
# heroku logs --tail -a $FINAL_NAME
