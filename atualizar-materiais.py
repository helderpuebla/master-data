from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import sys
import time
import webbrowser
from datetime import datetime
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit, urlunsplit
from urllib.request import Request, urlopen

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
SYSTEM_ID = "PASX06P"
SYNC_URL_DEFAULT = "http://localhost:8000/api/sync"
QUERY = """
SELECT TOP (1000)
       [Material number],
       [Material description],
       [Status]
FROM [ada].[dsi].[PASX_ALL_FACT_MM_STATUS]
WHERE ([Material number] LIKE '7%' OR [Material number] LIKE '8%')
  AND [SYSTEMID] = 'PASX06P'
  AND [Status] = 'NEW';
"""


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
        with pyodbc.connect(connection_string, timeout=30) as connection:
            connection.timeout = 60
            cursor = connection.cursor()
            cursor.execute(QUERY)
            rows = cursor.fetchall()
    except pyodbc.Error as error:
        raise RuntimeError(
            "Falha ao consultar a ADA com a autenticação integrada do Windows. "
            f"Detalhe: {error}"
        ) from error

    materials_by_number: dict[str, dict[str, str]] = {}
    for row in rows:
        number = "" if row[0] is None else str(row[0]).strip()
        description = "" if row[1] is None else str(row[1]).strip()
        status = "" if row[2] is None else str(row[2]).strip()
        if not number:
            raise RuntimeError("A consulta retornou um material sem número.")
        materials_by_number[number] = {
            "number": number,
            "description": description,
            "status": status,
        }
    return list(materials_by_number.values())


def sync_to_server(
    payload: dict[str, object], sync_url: str, sync_token: str
) -> str:
    if len(sync_token) < 32:
        raise RuntimeError("MASTER_DATA_SYNC_TOKEN ausente ou inválido no arquivo .env.")

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
        with urlopen(request, timeout=60) as response:
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
    except (TimeoutError, json.JSONDecodeError) as error:
        raise RuntimeError(f"Resposta inválida ou timeout do servidor: {error}") from error

    message = result.get("message") if isinstance(result, dict) else None
    if not isinstance(message, str) or not message:
        raise RuntimeError("O servidor respondeu sem confirmar a sincronização.")
    return message


def _server_health_url(site_url: str) -> str:
    parts = urlsplit(site_url)
    return urlunsplit((parts.scheme, parts.netloc, "/api/state", "", ""))


def _server_is_responding(health_url: str) -> bool:
    try:
        with urlopen(health_url, timeout=2):
            return True
    except HTTPError:
        return True
    except URLError:
        return False


def ensure_site_server(environment: dict[str, str], sync_url: str) -> str:
    sync_parts = urlsplit(sync_url)
    default_site_url = urlunsplit((sync_parts.scheme, sync_parts.netloc, "/", "", ""))
    site_url = environment.get("MASTER_DATA_SITE_URL", default_site_url)
    site_parts = urlsplit(site_url)
    if site_parts.scheme not in ("http", "https") or not site_parts.netloc:
        raise RuntimeError("MASTER_DATA_SITE_URL não é um endereço HTTP/HTTPS válido.")

    health_url = _server_health_url(site_url)
    if _server_is_responding(health_url):
        return site_url
    if site_parts.hostname not in ("localhost", "127.0.0.1", "::1"):
        raise RuntimeError(f"O servidor remoto não respondeu em {site_url}.")
    node = shutil.which("node")
    if not node:
        raise RuntimeError("Node.js não foi encontrado para iniciar o servidor do site.")
    flags = getattr(subprocess, "CREATE_NEW_CONSOLE", 0)
    try:
        subprocess.Popen(
            [node, "--use-system-ca", str(ROOT / "servidor-site.cjs")],
            cwd=ROOT,
            creationflags=flags,
        )
    except OSError as error:
        raise RuntimeError(f"Não foi possível iniciar o servidor: {error}") from error

    deadline = time.monotonic() + 15
    while time.monotonic() < deadline:
        if _server_is_responding(health_url):
            return site_url
        time.sleep(0.5)
    raise RuntimeError(f"O servidor não iniciou em {site_url}.")


def open_updated_site(site_url: str) -> str:
    if webbrowser.open(site_url, new=2):
        return f"Página atualizada aberta: {site_url}"
    return f"Sincronização concluída; abra a página manualmente em {site_url}."


def verify_setup() -> str:
    if pyodbc is None:
        raise RuntimeError(
            "A dependência pyodbc não está instalada. Instale-a com: python -m pip install -r requirements.txt"
        )
    if "ODBC Driver 18 for SQL Server" not in pyodbc.drivers():
        raise RuntimeError("O ODBC Driver 18 for SQL Server não está instalado neste computador.")
    environment = load_environment(ROOT / ".env")
    if not environment.get("ADA_SQL_SERVER"):
        raise RuntimeError("ADA_SQL_SERVER ausente no arquivo .env.")
    if len(environment.get("MASTER_DATA_SYNC_TOKEN", "")) < 32:
        raise RuntimeError("MASTER_DATA_SYNC_TOKEN ausente ou inválido no arquivo .env.")
    sync_url = environment.get("MASTER_DATA_SYNC_URL", SYNC_URL_DEFAULT)
    parsed_url = urlsplit(sync_url)
    if parsed_url.scheme not in ("http", "https") or not parsed_url.netloc:
        raise RuntimeError("MASTER_DATA_SYNC_URL não é um endereço HTTP/HTTPS válido.")
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
        if args.check_config:
            print(verify_setup())
            return 0

        print(verify_setup())
        environment = load_environment(ROOT / ".env")
        token = environment.get("MASTER_DATA_SYNC_TOKEN", "")
        sync_url = environment.get("MASTER_DATA_SYNC_URL", SYNC_URL_DEFAULT)
        if not token:
            raise RuntimeError("MASTER_DATA_SYNC_TOKEN não foi configurado no arquivo .env.")

        print("Conectando à ADA com a autenticação integrada do Windows...")
        materials = query_materials(environment["ADA_SQL_SERVER"])
        generated_at = datetime.now().astimezone().isoformat(timespec="seconds")
        site_url = ensure_site_server(environment, sync_url)
        result_message = sync_to_server(
            {
                "generatedAt": generated_at,
                "materials": materials,
                "legacyMaterials": [],
            },
            sync_url,
            token,
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
