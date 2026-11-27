from __future__ import annotations

import argparse
import json
import re
import shutil
import subprocess
import sys
import time
import webbrowser
from contextlib import closing
from datetime import datetime
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit, urlunsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener

try:
    import pyodbc
except ImportError:
    pyodbc = None


ROOT = (
    Path(sys.executable).resolve().parent
    if getattr(sys, "frozen", False)
    else Path(__file__).resolve().parent
)
DATABASE = "ada"
MAX_SNAPSHOT_ROWS = 1000
SYNC_URL_DEFAULT = "http://localhost:8000/api/sync"
QUERY = f"""
SELECT DISTINCT TOP ({MAX_SNAPSHOT_ROWS + 1})
       [Material number],
       [Material description],
       [Status]
FROM [ada].[dsi].[PASX_ALL_FACT_MM_STATUS]
WHERE ([Material number] LIKE '7%' OR [Material number] LIKE '8%')
  AND [SYSTEMID] = 'PASX06P'
  AND [Status] = 'NEW'
ORDER BY [Material number];
"""


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


HTTP = build_opener(NoRedirect())


def load_environment(path: Path) -> dict[str, str]:
    values: dict[str, str] = {}
    if not path.is_file():
        raise RuntimeError(
            "Arquivo .env não encontrado. Configure MASTER_DATA_SYNC_TOKEN antes de sincronizar."
        )

    for line in path.read_text(encoding="utf-8-sig").splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#") or "=" not in stripped:
            continue
        key, value = stripped.split("=", 1)
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
            value = value[1:-1]
        values[key.strip()] = value
    return values


def _odbc_value(value: str) -> str:
    return "{" + value.replace("}", "}}") + "}"


def query_materials(sql_server: str) -> list[dict[str, str]]:
    if pyodbc is None:
        raise RuntimeError(
            "A dependência pyodbc não está instalada. Instale-a com: python -m pip install -r requirements.txt"
        )
    if "ODBC Driver 18 for SQL Server" not in pyodbc.drivers():
        raise RuntimeError("O ODBC Driver 18 for SQL Server não está instalado neste computador.")

    connection_string = ";".join(
        (
            "Driver={ODBC Driver 18 for SQL Server}",
            f"Server={_odbc_value(sql_server)}",
            f"Database={_odbc_value(DATABASE)}",
            "Trusted_Connection=yes",
            "Encrypt=yes",
            "TrustServerCertificate=yes",
            "Connection Timeout=30",
            "Persist Security Info=no",
        )
    )

    try:
        with closing(pyodbc.connect(connection_string, timeout=30)) as connection:
            connection.timeout = 60
            cursor = connection.cursor()
            cursor.execute(QUERY)
            rows = cursor.fetchall()
    except pyodbc.Error as error:
        raise RuntimeError(
            "Falha ao consultar a ADA com a autenticação integrada do Windows. "
            f"Detalhe: {error}"
        ) from error

    if len(rows) > MAX_SNAPSHOT_ROWS:
        raise RuntimeError(
            f"A consulta excedeu o limite de {MAX_SNAPSHOT_ROWS} linhas. "
            "Nenhuma extração parcial foi enviada."
        )

    materials_by_number: dict[str, dict[str, str]] = {}
    for row in rows:
        number = "" if row[0] is None else str(row[0]).strip()
        description = "" if row[1] is None else str(row[1]).strip()
        status = "" if row[2] is None else str(row[2]).strip()
        if not re.fullmatch(r"[78][0-9]{0,19}", number) or status != "NEW":
            raise RuntimeError("A consulta retornou um número de material ou status inválido.")
        material = {
            "number": number,
            "description": description,
            "status": status,
        }
        if number in materials_by_number and materials_by_number[number] != material:
            raise RuntimeError(f"A consulta retornou dados divergentes para o material {number}.")
        materials_by_number[number] = material
    return list(materials_by_number.values())


def sync_to_server(
    payload: dict[str, object], sync_url: str, sync_token: str
) -> str:
    request = Request(
        sync_url,
        data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
        headers={
            "Content-Type": "application/json; charset=utf-8",
            "x-sync-token": sync_token,
        },
        method="POST",
    )
    try:
        with HTTP.open(request, timeout=60) as response:
            result = json.loads(response.read().decode("utf-8"))
    except HTTPError as error:
        detail = error.read().decode("utf-8", errors="replace")[:500]
        raise RuntimeError(
            f"O servidor recusou a sincronização (HTTP {error.code}): {detail}"
        ) from error
    except URLError as error:
        raise RuntimeError(
            f"Não foi possível conectar ao servidor local em {sync_url}: {error.reason}"
        ) from error
    except (TimeoutError, ValueError) as error:
        raise RuntimeError(f"Resposta inválida ou timeout do servidor: {error}") from error

    message = result.get("message") if isinstance(result, dict) else None
    if not isinstance(message, str) or not message:
        raise RuntimeError("O servidor respondeu sem confirmar a sincronização.")
    return message


def _server_is_responding(health_url: str) -> bool:
    try:
        with HTTP.open(health_url, timeout=2) as response:
            result = json.loads(response.read(1024))
            return isinstance(result, dict) and result.get("application") == "master-data"
    except (OSError, ValueError):
        return False


def ensure_sync_server(sync_url: str) -> None:
    sync_parts = urlsplit(sync_url)
    health_url = urlunsplit((sync_parts.scheme, sync_parts.netloc, "/api/health", "", ""))
    if _server_is_responding(health_url):
        return
    if sync_parts.scheme != "http" or sync_parts.hostname not in ("localhost", "127.0.0.1"):
        raise RuntimeError(f"O servidor de sincronização não respondeu em {health_url}.")
    node = shutil.which("node")
    if not node:
        raise RuntimeError("Node.js não foi encontrado para iniciar o servidor do site.")
    flags = getattr(subprocess, "CREATE_NEW_CONSOLE", 0)
    try:
        process = subprocess.Popen(
            [node, "--use-system-ca", str(ROOT / "servidor-site.cjs")],
            cwd=ROOT,
            creationflags=flags,
        )
    except OSError as error:
        raise RuntimeError(f"Não foi possível iniciar o servidor: {error}") from error

    deadline = time.monotonic() + 15
    while time.monotonic() < deadline:
        if _server_is_responding(health_url):
            return
        if process.poll() is not None:
            break
        time.sleep(0.5)
    raise RuntimeError(f"O servidor não iniciou em {health_url}. Verifique a configuração de PORT.")


def open_updated_site(site_url: str) -> str:
    if webbrowser.open(site_url, new=2):
        return f"Página atualizada aberta: {site_url}"
    return f"Sincronização concluída; abra a página manualmente em {site_url}."


def validate_url(url: str, key: str) -> None:
    try:
        parts = urlsplit(url)
        if (parts.scheme in ("http", "https") and parts.hostname and
                parts.username is None and (parts.port is None or parts.port > 0)):
            return
    except ValueError:
        pass
    raise RuntimeError(f"{key} não é um endereço HTTP/HTTPS válido.")


def verify_setup(environment: dict[str, str], site_url: str) -> str:
    if pyodbc is None:
        raise RuntimeError(
            "A dependência pyodbc não está instalada. Instale-a com: python -m pip install -r requirements.txt"
        )
    if "ODBC Driver 18 for SQL Server" not in pyodbc.drivers():
        raise RuntimeError("O ODBC Driver 18 for SQL Server não está instalado neste computador.")
    if environment.get("ADA_SQL_SERVER") in (None, "", "your-ada-sql-server"):
        raise RuntimeError("ADA_SQL_SERVER ausente no arquivo .env.")
    token = environment.get("MASTER_DATA_SYNC_TOKEN", "")
    if len(token) < 32 or not re.fullmatch(r"[!-~]+", token):
        raise RuntimeError("MASTER_DATA_SYNC_TOKEN ausente ou inválido no arquivo .env.")
    validate_url(site_url, "MASTER_DATA_SITE_URL")
    return "Configuração local OK: Python, pyodbc, ODBC Driver 18 e token de sincronização."


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Consulta materiais NEW na ADA e sincroniza com o Supabase.")
    parser.add_argument(
        "--check-config",
        action="store_true",
        help="Valida dependências e configuração local sem acessar a ADA ou gravar no Supabase.",
    )
    args = parser.parse_args(argv)
    try:
        environment = load_environment(ROOT / ".env")
        sync_url = environment.get("MASTER_DATA_SYNC_URL", SYNC_URL_DEFAULT)
        validate_url(sync_url, "MASTER_DATA_SYNC_URL")
        sync_parts = urlsplit(sync_url)
        default_site_url = urlunsplit((sync_parts.scheme, sync_parts.netloc, "/", "", ""))
        site_url = environment.get("MASTER_DATA_SITE_URL", default_site_url)
        print(verify_setup(environment, site_url))
        if args.check_config:
            return 0

        ensure_sync_server(sync_url)
        print("Conectando à ADA com a autenticação integrada do Windows...")
        generated_at = datetime.now().astimezone().isoformat()
        materials = query_materials(environment["ADA_SQL_SERVER"])
        result_message = sync_to_server(
            {
                "generatedAt": generated_at,
                "materials": materials,
                "legacyMaterials": [],
            },
            sync_url,
            environment["MASTER_DATA_SYNC_TOKEN"],
        )
        print(f"Consulta concluída: {len(materials)} materiais NEW encontrados.")
        print(result_message)
        print(open_updated_site(site_url))
        return 0
    except KeyboardInterrupt:
        print("\nOperação cancelada.", file=sys.stderr)
        return 130
    except Exception as error:
        print(f"Falha ao atualizar os dados no Supabase: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
