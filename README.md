# Truco Online

Projeto multiplayer de Truco com Node.js e WebSocket nativo, preparado para hospedagem no Render.

## Arquivos
- `server.js`: servidor do jogo (baseado no arquivo enviado).
- `index.html`: interface do lobby, mesa, cartas, placar e chat.
- `package.json`: comando de inicialização.

## Executar no computador
1. Instale Node.js 18 ou superior.
2. Abra um terminal nesta pasta.
3. Execute `npm start`.
4. Acesse http://localhost:3000.

## Publicar no GitHub e Render
1. Crie um repositório novo chamado `truco-online` no GitHub.
2. Envie os três arquivos (`server.js`, `index.html` e `package.json`) para a raiz do repositório.
3. No Render, crie um **Web Service** e conecte esse novo repositório.
4. Configure:
   - Runtime: Node
   - Build Command: `npm install`
   - Start Command: `npm start`
   - Instance Type: Free para testes
5. Conclua o deploy e abra o endereço gerado pelo Render.

## Observações desta primeira versão
- Uma única sala/mesa por instância do servidor.
- Modos disponíveis no servidor: dupla (4 jogadores), trio (6 jogadores) e todos contra todos (2 a 6 jogadores).
- O servidor mantém estado em memória; reiniciar a instância encerra a partida.
- A lógica de regras é a que já estava implementada no servidor enviado. Recomenda-se testar todas as situações de jogo antes de divulgar o endereço.
