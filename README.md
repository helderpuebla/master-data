# Controle de Master Data

Aplicação web para acompanhar os fluxos de materiais 7-Item e 8-Item. O Supabase compartilha os materiais e o andamento; o sincronizador Python consulta a ADA e importa novos itens com status `NEW`.

## Componentes

- `site/index.html`: interface e etapas do fluxo, com salvamento compartilhado no Supabase.
- `servidor-site.cjs`: servidor HTTP local e API. A chave privilegiada do Supabase permanece apenas no servidor.
- `atualizar-materiais.py`: consulta a ADA usando autenticação integrada do Windows e sincroniza materiais.
- `atualizar-materiais.exe`: executável Windows correspondente ao script Python.
- `supabase-schema.sql`: tabelas e funções RPC necessárias no Supabase.
- `SUPABASE_SETUP.md`: instruções detalhadas de configuração e segurança.

## Pré-requisitos

- Windows com acesso autorizado à ADA e Microsoft ODBC Driver 18 for SQL Server para executar a consulta.
- Node.js com suporte a `--use-system-ca` para iniciar o servidor.
- Arquivo `.env` local, criado a partir de `.env.example` e preenchido com os segredos do Supabase, o endereço do SQL Server ADA (`ADA_SQL_SERVER`) e os demais valores locais.
- Projeto Supabase configurado com `supabase-schema.sql`.

## Executar

1. Configure o `.env` conforme `SUPABASE_SETUP.md`.
2. Execute `iniciar-site.cmd` para disponibilizar a página.
3. Execute `atualizar-materiais.cmd` no computador que tem acesso à ADA para consultar e sincronizar os novos materiais.
4. Abra a página em `http://localhost:8000/`. Outros computadores precisam usar o endereço de rede do computador servidor e ter acesso autorizado pela rede/firewall.

O andamento alterado na página é gravado no Supabase. Se o computador servidor estiver desligado, a página servida por ele fica indisponível; os dados já sincronizados permanecem no Supabase.

## Hospedagem do site

A hospedagem precisa executar Node.js para servir a interface e a API. Use `node servidor-site.cjs` como comando de inicialização e configure `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` e `MASTER_DATA_SYNC_TOKEN` nas variáveis do ambiente do servidor. O processo lê `PORT` quando a hospedagem define a porta.

Restrinja o acesso à equipe pela rede corporativa ou por um gateway HTTPS com autenticação. O sincronizador Python continua no Windows autorizado a consultar a ADA. Nesse computador, configure `MASTER_DATA_SYNC_URL` para o endereço HTTPS do serviço, terminado em `/api/sync`, e valide se o gateway permite a autenticação do sincronizador.

## GitHub e dados locais

Não publique `.env`, chaves, tokens, dados de materiais ou exportações da ADA. O arquivo `.env` está no `.gitignore` e deve permanecer somente localmente. Os materiais e o andamento são mantidos no Supabase.

Para reconstruir o executável após alterar o script:

```powershell
python -m PyInstaller --onefile --console --name atualizar-materiais --distpath . --workpath .pyinstaller-build --noconfirm atualizar-materiais.py
```

Valide a configuração local sem consultar a ADA:

```powershell
.\atualizar-materiais.exe --check-config
```
