# Conversion Tracker privado

Primeira iteração de um rastreador próprio para diagnosticar o funil da loja. O projeto recebe eventos do navegador, preserva a origem da campanha e grava tudo em uma tabela privada do Supabase.

## O que já está pronto

- `public/tracker.js`: script instalável na loja.
- `POST /api/events`: endpoint com validação, CORS e deduplicação.
- IDs anônimos de visitante e sessão.
- Captura de URL, referrer, dispositivo, UTMs e `fbclid`.
- Eventos automáticos de `page_view`.
- Eventos por atributos `data-track` ou chamada JavaScript.
- Migration SQL para a tabela `analytics_events`.
- Página local para testar o funil inteiro.

## 1. Criar a tabela no Supabase

Abra o **SQL Editor** do seu projeto Supabase e execute o arquivo:

```text
supabase/migrations/001_create_analytics_events.sql
```

A tabela usa RLS sem políticas públicas. Somente a API, usando a service role no servidor, grava os eventos.

## 2. Configurar as variáveis

Copie o exemplo:

```bash
cp .env.example .env.local
```

Preencha:

```env
NEXT_PUBLIC_SUPABASE_URL=https://SEU_PROJETO.supabase.co
SUPABASE_SERVICE_ROLE_KEY=SUA_SERVICE_ROLE_KEY
TRACKING_ALLOWED_ORIGINS=http://localhost:3000,https://seu-dominio.com.br
```

Nunca coloque `SUPABASE_SERVICE_ROLE_KEY` no script da loja ou em uma variável `NEXT_PUBLIC_*`.

## 3. Rodar localmente

```bash
npm install
npm run dev
```

Abra `http://localhost:3000`. O `page_view` será disparado automaticamente. Clique nos quatro botões da bancada de testes e confirme os registros em **Supabase → Table Editor → analytics_events**.

Com `data-debug="true"`, o tracker mostra no console do navegador cada evento enviado ou recusado.

## 4. Publicar na Vercel

Importe este repositório na Vercel e cadastre as mesmas variáveis de ambiente. Depois do deploy, o tracker ficará disponível em:

```text
https://SEU-APP.vercel.app/tracker.js
```

Atualize `TRACKING_ALLOWED_ORIGINS` com o domínio exato da loja e faça um novo deploy.

## 5. Instalar no site da loja

Adicione antes do fechamento de `</body>`:

```html
<script
  defer
  src="https://SEU-APP.vercel.app/tracker.js">
</script>
```

O script encontra automaticamente a API no mesmo domínio em que o `tracker.js` está hospedado.

## 6. Marcar ações do funil

### Botão de compra

```html
<button
  data-track="buy_button_click"
  data-track-properties='{"product_id":"watch_01","price":89.90}'>
  Comprar agora
</button>
```

### Adicionar ao carrinho

```html
<button
  data-track="add_to_cart"
  data-track-properties='{"product_id":"watch_01","quantity":1,"price":89.90}'>
  Adicionar ao carrinho
</button>
```

### Eventos disparados pelo código da loja

```html
<script>
  window.ConversionTracker?.track("checkout_started", {
    cart_value: 89.90,
    currency: "BRL"
  });
</script>
```

Para uma compra:

```html
<script>
  window.ConversionTracker?.track("purchase", {
    order_id: "PEDIDO-123",
    value: 89.90,
    currency: "BRL"
  });
</script>
```

Nesta primeira iteração, `purchase` pode ser disparado na página de agradecimento. A confirmação por webhook do pagamento entra em uma iteração posterior.

## Eventos recomendados

```text
page_view
product_view
buy_button_click
add_to_cart
checkout_started
purchase
```

Nomes personalizados também funcionam, desde que usem apenas letras minúsculas, números e `_`, comecem por uma letra e tenham até 64 caracteres.

## Teste rápido no console

Depois que o tracker carregar:

```js
ConversionTracker.track("add_to_cart", {
  product_id: "watch_01",
  price: 89.90
});
```

Na aba **Network**, procure uma requisição `POST /api/events` com resposta `201`.

## Dados que não são coletados

O tracker não captura conteúdo de formulários, nome, e-mail, telefone, endereço ou dados de pagamento. Ele registra apenas eventos de navegação e propriedades que forem enviadas explicitamente.
