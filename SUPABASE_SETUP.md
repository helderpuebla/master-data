# Configuração do Supabase

## Preparação

1. Confirme que o projeto Supabase escolhido está aprovado para os dados da ADA.
2. No SQL Editor do projeto, execute todo o conteúdo de `supabase-schema.sql`.
3. Copie `.env.example` para `.env` na pasta principal.
4. Preencha `SUPABASE_URL` e `SUPABASE_SERVICE_ROLE_KEY` com os valores do projeto. A chave `service_role` fica somente no servidor: nunca a coloque na página nem a compartilhe.
5. Configure `ADA_SQL_SERVER` com o endereço do SQL Server fornecido pela equipe de dados. Esse valor fica apenas no `.env` local e não deve ser publicado.
6. Gere um segredo longo para `MASTER_DATA_SYNC_TOKEN` (por exemplo, com `node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"`) e use o mesmo `.env` para o site e o sincronizador.
7. Revise `MASTER_DATA_SYNC_URL` e `PORT` se o servidor for executado em outra porta ou computador. Se o navegador deve abrir um endereço diferente do servidor de sincronização, defina `MASTER_DATA_SITE_URL`.

Ao atualizar a aplicação, execute novamente todo o `supabase-schema.sql` antes de iniciar o servidor atualizado. O script preserva as tabelas e instala a função que verifica alterações concorrentes no andamento.

## Uso

1. Execute `atualizar-materiais.exe` ou dê duplo clique em `atualizar-materiais.cmd`. O programa usa a autenticação integrada da conta Windows atual, sem pedir senha, consulta os materiais `7...` e `8...` com status `NEW` e sincroniza com o Supabase.
2. Após sincronizar, o programa inicia o servidor local se necessário e abre a página atualizada no navegador. A página atualiza dados compartilhados a cada 15 segundos.
3. O 7-Item usa o fluxo complexo (Master Data, PVL, PMBR e PCD). O 8-Item mantém o fluxo temporal anterior de Master Data: criação no SAP, aprovação no SAP pelo QA, status NEW no PAS-X, configuração da Master Data, Q-Case, decisão do QA e Acknowledge. O Q-Case é obrigatório para registrar a decisão do QA; a aprovação e o Acknowledge controlam a liberação.

Para iniciar a página sem sincronizar, use `iniciar-site.cmd`. O inicializador usa o armazenamento de certificados do Windows (`--use-system-ca`), sem desativar validação TLS; requer uma versão do Node.js que reconheça essa opção.

Os materiais e o andamento são mantidos no Supabase. O andamento já salvo no `localStorage` deste navegador é migrado para o Supabase quando não existir registro remoto para aquele material.

Se outra sessão alterar o mesmo material entre a leitura e o salvamento, a página informa o conflito e busca a versão atual. Consulte o andamento atualizado antes de tentar salvar de novo.

O executável depende do Microsoft ODBC Driver 18 for SQL Server instalado no computador. Para corresponder ao perfil ADA existente no VS Code, a conexão usa `TrustServerCertificate=yes`; isso não valida o certificado do servidor e aumenta o risco de interceptação TLS. Use somente na rede e no cenário corporativo aprovados. `atualizar-materiais.exe --check-config` verifica a configuração local sem acessar a ADA ou gravar no banco. Para reconstruí-lo após alterar o script, use `python -m PyInstaller --onefile --console --name atualizar-materiais --distpath . --workpath .pyinstaller-build --noconfirm atualizar-materiais.py`.

## Acesso e segurança

O aplicativo não exige login, conforme definido para esta implantação. Assim, qualquer pessoa que consiga acessar o servidor web pode consultar e alterar o andamento. O site escuta na rede (`0.0.0.0`); restrinja o acesso por firewall/rede corporativa e não o exponha à internet. O site usa HTTP: para acesso por outros computadores, use uma rede confiável e coloque-o atrás de um proxy HTTPS corporativo. Mantenha `MASTER_DATA_SYNC_URL` em `localhost` sempre que possível; se o sincronizador enviar dados pela rede, use somente uma conexão protegida. O segredo de sincronização protege somente a importação da ADA. A chave privilegiada do Supabase permanece no servidor e as tabelas não concedem acesso às chaves públicas do Supabase.
