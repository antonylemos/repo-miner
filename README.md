# Descoberta de repositórios

CLI TypeScript para buscar candidatos públicos no GitHub, registrar a proveniência de cada resultado e exportar um diagnóstico de volume e cobertura. Esta etapa coleta resultados de busca; ela não confirma implementações de micro-frontends, abordagens ou elegibilidade.

## Requisitos e instalação

- Node.js 26.9.0, conforme `.nvmrc`.
- pnpm 9.15.9, declarado em `package.json`.

Com fnm e Corepack instalados:

```sh
fnm install
fnm use
corepack enable
pnpm install --frozen-lockfile
pnpm run build
```

Verificações locais:

```sh
pnpm run check
pnpm run typecheck
pnpm test
```

## Credencial do GitHub

As buscas de descoberta exigem `GITHUB_TOKEN`. Configure a credencial no ambiente do processo que executa a CLI. A CLI usa o token somente em `discover`; não o grava no banco nem nos relatórios. Comandos `report` e `--help` não precisam de credencial.

```sh
export GITHUB_TOKEN='<token>'
```

## Comandos

Conferir a partição antes de uma rodada. O dry-run expande o catálogo, consulta apenas o total de cada subconsulta e não cria arquivos; retorna `2` se alguma subconsulta passar de 1.000 resultados:

```sh
pnpm run cli discover --queries config/discovery.queries.json --dry-run > dry-run.md
```

Criar uma rodada nova:

```sh
pnpm run cli discover --queries config/discovery.queries.json --output data/discovery/rodada-001
```

Retomar uma rodada interrompida ou parcial. A retomada usa o catálogo e as subconsultas persistidos em `discovery.sqlite` e refaz apenas buscas e enriquecimentos pendentes ou com falha:

```sh
pnpm run cli discover --resume data/discovery/rodada-001
```

Regenerar os relatórios sem token:

```sh
pnpm run cli report --run data/discovery/rodada-001
```

Uma rodada nova não reutiliza um diretório que já contenha `discovery.sqlite`. Bancos criados pela versão anterior do catálogo não são abertos.

## Catálogo

O catálogo (`version: 2`) declara um recorte global `filters.pushedSince` e, por consulta, `rationale` obrigatório e uma partição opcional:

- `{"by": "created", "from": "2019-01-01", "interval": "month" | "quarter" | "year"}` para `repositories`;
- `{"by": "size", "bounds": [0, 1000, 2000]}` para `code`.

A CLI expande cada consulta em subconsultas com `pushed:>=`, `created:` e `size:` gerados; esses qualificadores não podem ser escritos à mão em `q`. Candidatos encontrados apenas pela busca de código são enriquecidos pela API GraphQL para obter `pushedAt` e metadados de filtragem.

## Saídas

O diretório da rodada contém `discovery.sqlite`, que guarda páginas, candidatos, hits, checkpoints e proveniência. A CLI exporta:

- `candidates.csv`: um registro por id de repositório, com `scope` (`in_scope`, `out_of_scope_temporal`, `unknown`), `pushed_at` e sua fonte, status de enriquecimento e estratégias que o encontraram;
- `discovery-hits.csv`: todas as origens, com consulta, subconsulta, `q` efetivo, endpoint, data de coleta e caminho;
- `coverage.json`: cobertura por consulta, estratégia e contagens de hits e repositórios distintos;
- `report.md`: diagnóstico narrativo, contagens, interseções, consultas saturadas e limitações;
- `manifest.json`: id, datas e hash do catálogo da rodada, versões disponíveis e SHA-256 dos arquivos exportados.

Os arquivos CSV preservam Unicode e escapam vírgulas, aspas e quebras de linha conforme as regras CSV. Metadados de busca ficam na coluna `metadata_json`.

## Códigos de saída

- `0`: todas as consultas terminaram sem sinalização de cobertura parcial;
- `1`: erro fatal, como argumentos inválidos, credencial ausente ou banco inexistente;
- `2`: rodada parcial, incluindo consultas incompletas, saturadas, falhas recuperáveis ou interrupção.

Uma rodada parcial conserva as páginas confirmadas e os checkpoints para retomada. Uma consulta marcada como parcial por incompletude ou limite de resultados é terminal nessa rodada; revise o catálogo e crie outra rodada para refazer a busca.

## Limitações

A API de busca do GitHub depende da indexação do serviço. Os resultados podem mudar durante a rodada, ser incompletos e estar sujeitos ao limite de resultados por consulta. O executor busca no máximo dez páginas por consulta e registra buscas saturadas para revisão. Os totais descrevem os resultados destas consultas, não a população de repositórios.

As contagens não são prevalência de micro-frontends nem contagens de implementações confirmadas. Classificação arquitetural, tipo de projeto e elegibilidade ficam para triagem humana posterior. O armazenamento usa `node:sqlite`, integrado à versão de Node fixada no projeto.

As APIs de busca excluem forks por padrão. A busca de código considera apenas a branch padrão e arquivos de até 384 KB e não aceita filtros de data; o recorte temporal desses candidatos depende do enriquecimento.

## Registro da etapa

Consulte [01-descoberta.md](docs/etapas/01-descoberta.md) para o estado e os resultados verificados da etapa.
