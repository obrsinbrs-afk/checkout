require('dotenv').config();
const express    = require('express');
const axios      = require('axios');
const cors       = require('cors');
const multer     = require('multer');
const path       = require('path');
const fs         = require('fs');
const { v4: uuidv4 } = require('uuid');
const session    = require('express-session');
const nodemailer = require('nodemailer');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));
app.use(session({
  secret: process.env.SESSION_SECRET || 'secret123',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 8 * 60 * 60 * 1000 }
}));

const PUSHINPAY_TOKEN = process.env.PUSHINPAY_TOKEN;
const PUSHINPAY_BASE  = 'https://api.pushinpay.com.br/api';
const DATA_DIR        = path.join(__dirname, 'data');
const UPLOADS_DIR     = path.join(__dirname, 'uploads');

// ── Helpers JSON ───────────────────────────────────────────────────
const lerJSON    = (f) => JSON.parse(fs.readFileSync(path.join(DATA_DIR, f), 'utf8'));
const salvarJSON = (f, d) => fs.writeFileSync(path.join(DATA_DIR, f), JSON.stringify(d, null, 2));

// ── Upload ─────────────────────────────────────────────────────────
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOADS_DIR),
  filename:    (req, file, cb) => cb(null, `${uuidv4()}${path.extname(file.originalname)}`),
});
const upload = multer({ storage, limits: { fileSize: 50 * 1024 * 1024 } });

// ── Email ──────────────────────────────────────────────────────────
const transporter = nodemailer.createTransport({
  host:   process.env.SMTP_HOST || 'smtp.gmail.com',
  port:   parseInt(process.env.SMTP_PORT) || 587,
  secure: false,
  auth:   { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
});

async function enviarProduto(transaction, produto, isOrderBump = false) {
  const attachments = [];
  if (produto.arquivo_path) {
    attachments.push({
      filename: produto.arquivo_nome || 'produto',
      path: path.join(UPLOADS_DIR, path.basename(produto.arquivo_path)),
    });
  }
  const conteudo = (produto.email_corpo || '')
    .replace(/{nome}/g, transaction.nome)
    .replace(/{produto}/g, produto.nome)
    || `Olá ${transaction.nome}, obrigado pela sua compra de <b>${produto.nome}</b>!`;

  await transporter.sendMail({
    from:    `"${produto.email_remetente || 'Loja'}" <${process.env.EMAIL_FROM}>`,
    to:      transaction.email,
    subject: produto.email_assunto || `Seu produto: ${produto.nome}`,
    html: `
      <div style="font-family:sans-serif;max-width:560px;margin:0 auto;">
        <div style="background:${isOrderBump ? '#7c3aed' : '#e91e8c'};padding:24px;text-align:center;border-radius:12px 12px 0 0;">
          <h1 style="color:#fff;margin:0;font-size:22px;">✅ ${isOrderBump ? 'Bônus Incluído!' : 'Compra Confirmada!'}</h1>
        </div>
        <div style="background:#fff;padding:28px;border:1px solid #eee;border-radius:0 0 12px 12px;">
          ${conteudo}
          ${produto.link_entrega ? `
          <div style="margin-top:20px;text-align:center;">
            <a href="${produto.link_entrega}"
               style="background:${isOrderBump ? '#7c3aed' : '#e91e8c'};color:#fff;padding:14px 28px;border-radius:10px;text-decoration:none;font-weight:700;font-size:15px;">
              Acessar ${isOrderBump ? 'Bônus' : 'Produto'}
            </a>
          </div>` : ''}
          <p style="margin-top:24px;font-size:12px;color:#aaa;text-align:center;">Em caso de dúvidas, responda este e-mail.</p>
        </div>
      </div>`,
    attachments,
  });
}

// ── Middleware admin ───────────────────────────────────────────────
function authAdmin(req, res, next) {
  if (req.session?.admin) return next();
  res.status(401).json({ erro: 'Não autorizado' });
}

// ── Auth ───────────────────────────────────────────────────────────
app.post('/admin/login', (req, res) => {
  const { usuario, senha } = req.body;
  if (usuario === process.env.ADMIN_USER && senha === process.env.ADMIN_PASS) {
    req.session.admin = true;
    return res.json({ ok: true });
  }
  res.status(401).json({ erro: 'Usuário ou senha incorretos' });
});
app.post('/admin/logout', (req, res) => { req.session.destroy(); res.json({ ok: true }); });
app.get('/admin/me', (req, res) => res.json({ logado: !!req.session?.admin }));

// ── Páginas admin ──────────────────────────────────────────────────
app.get('/admin',       (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));
app.get('/admin/login', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin-login.html')));

// ── Produtos ───────────────────────────────────────────────────────
app.get('/admin/api/produtos', authAdmin, (req, res) => res.json(lerJSON('products.json')));

app.post('/admin/api/produtos', authAdmin, upload.single('arquivo'), (req, res) => {
  const produtos = lerJSON('products.json');
  const novo = {
    id: uuidv4().slice(0, 8),
    nome:            req.body.nome,
    valor:           parseFloat(req.body.valor),
    descricao:       req.body.descricao || '',
    link_entrega:    req.body.link_entrega || '',
    arquivo_path:    req.file ? `/uploads/${req.file.filename}` : '',
    arquivo_nome:    req.file ? req.file.originalname : '',
    email_assunto:   req.body.email_assunto || '',
    email_remetente: req.body.email_remetente || '',
    email_corpo:     req.body.email_corpo || '',
    criado:          new Date().toISOString(),
  };
  produtos.push(novo);
  salvarJSON('products.json', produtos);
  res.json(novo);
});

app.put('/admin/api/produtos/:id', authAdmin, upload.single('arquivo'), (req, res) => {
  const produtos = lerJSON('products.json');
  const idx = produtos.findIndex(p => p.id === req.params.id);
  if (idx === -1) return res.status(404).json({ erro: 'Não encontrado' });
  produtos[idx] = {
    ...produtos[idx],
    nome:            req.body.nome            ?? produtos[idx].nome,
    valor:           req.body.valor           ? parseFloat(req.body.valor) : produtos[idx].valor,
    descricao:       req.body.descricao       ?? produtos[idx].descricao,
    link_entrega:    req.body.link_entrega     ?? produtos[idx].link_entrega,
    email_assunto:   req.body.email_assunto    ?? produtos[idx].email_assunto,
    email_remetente: req.body.email_remetente  ?? produtos[idx].email_remetente,
    email_corpo:     req.body.email_corpo      ?? produtos[idx].email_corpo,
    ...(req.file ? { arquivo_path: `/uploads/${req.file.filename}`, arquivo_nome: req.file.originalname } : {}),
  };
  salvarJSON('products.json', produtos);
  res.json(produtos[idx]);
});

app.delete('/admin/api/produtos/:id', authAdmin, (req, res) => {
  let p = lerJSON('products.json');
  salvarJSON('products.json', p.filter(x => x.id !== req.params.id));
  res.json({ ok: true });
});

// ── Order Bumps ────────────────────────────────────────────────────
app.get('/api/orderbumps', (req, res) => {
  // público — checkout busca para exibir
  const bumps = lerJSON('orderbumps.json').filter(b => b.ativo);
  res.json(bumps);
});

app.get('/admin/api/orderbumps', authAdmin, (req, res) => res.json(lerJSON('orderbumps.json')));

app.post('/admin/api/orderbumps', authAdmin, upload.single('imagem'), (req, res) => {
  const bumps = lerJSON('orderbumps.json');
  const novo = {
    id:              uuidv4().slice(0, 8),
    titulo:          req.body.titulo,
    descricao:       req.body.descricao || '',
    valor:           parseFloat(req.body.valor),
    imagem:          req.file ? `/uploads/${req.file.filename}` : '',
    // produto vinculado (email de entrega)
    produto_id:      req.body.produto_id || '',
    // ou campos diretos
    link_entrega:    req.body.link_entrega || '',
    arquivo_path:    '',
    arquivo_nome:    '',
    email_assunto:   req.body.email_assunto || '',
    email_corpo:     req.body.email_corpo || '',
    ativo:           true,
    criado:          new Date().toISOString(),
  };
  bumps.push(novo);
  salvarJSON('orderbumps.json', bumps);
  res.json(novo);
});

app.put('/admin/api/orderbumps/:id', authAdmin, upload.single('imagem'), (req, res) => {
  const bumps = lerJSON('orderbumps.json');
  const idx = bumps.findIndex(b => b.id === req.params.id);
  if (idx === -1) return res.status(404).json({ erro: 'Não encontrado' });
  bumps[idx] = {
    ...bumps[idx],
    titulo:        req.body.titulo        ?? bumps[idx].titulo,
    descricao:     req.body.descricao     ?? bumps[idx].descricao,
    valor:         req.body.valor         ? parseFloat(req.body.valor) : bumps[idx].valor,
    link_entrega:  req.body.link_entrega   ?? bumps[idx].link_entrega,
    email_assunto: req.body.email_assunto  ?? bumps[idx].email_assunto,
    email_corpo:   req.body.email_corpo    ?? bumps[idx].email_corpo,
    produto_id:    req.body.produto_id     ?? bumps[idx].produto_id,
    ativo:         req.body.ativo !== undefined ? req.body.ativo === 'true' : bumps[idx].ativo,
    ...(req.file ? { imagem: `/uploads/${req.file.filename}` } : {}),
  };
  salvarJSON('orderbumps.json', bumps);
  res.json(bumps[idx]);
});

app.delete('/admin/api/orderbumps/:id', authAdmin, (req, res) => {
  let b = lerJSON('orderbumps.json');
  salvarJSON('orderbumps.json', b.filter(x => x.id !== req.params.id));
  res.json({ ok: true });
});

// ── Transações ─────────────────────────────────────────────────────
app.get('/admin/api/transacoes', authAdmin, (req, res) => {
  const txs = lerJSON('transactions.json');
  res.json(txs.sort((a, b) => new Date(b.criado) - new Date(a.criado)));
});

app.post('/admin/api/reenviar/:id', authAdmin, async (req, res) => {
  const txs     = lerJSON('transactions.json');
  const tx      = txs.find(t => t.id === req.params.id);
  const produtos = lerJSON('products.json');
  const bumps    = lerJSON('orderbumps.json');

  if (!tx) return res.status(404).json({ erro: 'Transação não encontrada' });
  try {
    // reenviar produto principal
    if (tx.produto_id) {
      const p = produtos.find(x => x.id === tx.produto_id);
      if (p) await enviarProduto(tx, p, false);
    }
    // reenviar bumps
    for (const bumpId of (tx.bumps_ids || [])) {
      const b = bumps.find(x => x.id === bumpId);
      if (b) {
        const produtoBump = b.produto_id ? produtos.find(x => x.id === b.produto_id) : b;
        if (produtoBump) await enviarProduto(tx, produtoBump, true);
      }
    }
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ erro: e.message });
  }
});

// ── Leads / Abandonados ────────────────────────────────────────────
app.post('/api/lead', (req, res) => {
  const { nome, email, celular, cpf } = req.body;
  if (!email) return res.status(400).json({ erro: 'Email obrigatório' });

  const leads = lerJSON('abandoned.json');
  const idx   = leads.findIndex(l => l.email === email);
  const dados = {
    id:        idx >= 0 ? leads[idx].id : uuidv4().slice(0, 8),
    nome:      nome || '',
    email,
    celular:   celular || '',
    cpf:       cpf || '',
    status:    'abandonado',
    criado:    idx >= 0 ? leads[idx].criado : new Date().toISOString(),
    atualizado: new Date().toISOString(),
  };

  if (idx >= 0) leads[idx] = dados;
  else leads.push(dados);
  salvarJSON('abandoned.json', leads);
  res.json({ ok: true });
});

// Marcar como convertido (chamado internamente no webhook)
function marcarLeadConvertido(email) {
  const leads = lerJSON('abandoned.json');
  const idx   = leads.findIndex(l => l.email === email);
  if (idx >= 0) { leads[idx].status = 'convertido'; salvarJSON('abandoned.json', leads); }
}

app.get('/admin/api/abandonados', authAdmin, (req, res) => {
  const leads = lerJSON('abandoned.json');
  res.json(leads.filter(l => l.status === 'abandonado').sort((a, b) => new Date(b.atualizado) - new Date(a.atualizado)));
});

app.get('/admin/api/abandonados/todos', authAdmin, (req, res) => {
  const leads = lerJSON('abandoned.json');
  res.json(leads.sort((a, b) => new Date(b.atualizado) - new Date(a.atualizado)));
});

app.delete('/admin/api/abandonados/:id', authAdmin, (req, res) => {
  let leads = lerJSON('abandoned.json');
  leads = leads.filter(l => l.id !== req.params.id);
  salvarJSON('abandoned.json', leads);
  res.json({ ok: true });
});

// ── Tracking ───────────────────────────────────────────────────────
app.get('/api/tracking', (req, res) => res.json(lerJSON('tracking.json')));

app.get('/admin/api/tracking', authAdmin, (req, res) => res.json(lerJSON('tracking.json')));

app.put('/admin/api/tracking', authAdmin, (req, res) => {
  const atual = lerJSON('tracking.json');
  const novo  = { ...atual, ...req.body };
  salvarJSON('tracking.json', novo);
  res.json(novo);
});

// ── Upload genérico ────────────────────────────────────────────────
app.post('/api/upload', upload.single('imagem'), (req, res) => {
  if (!req.file) return res.status(400).json({ erro: 'Nenhum arquivo enviado.' });
  res.json({ url: `/uploads/${req.file.filename}` });
});

// ── Criar cobrança PIX ─────────────────────────────────────────────
app.post('/api/criar-cobranca', async (req, res) => {
  const { nome, email, cpf, celular, valor, descricao, produto_id, bumps_ids } = req.body;
  if (!nome || !email || !cpf || !valor)
    return res.status(400).json({ erro: 'Campos obrigatórios faltando.' });

  try {
    const payload = {
      value:       Math.round(valor * 100),
      webhook_url: process.env.WEBHOOK_URL,
      payer: {
        name:     nome,
        email,
        document: cpf.replace(/\D/g, ''),
        phone:    celular ? celular.replace(/\D/g, '') : undefined,
      },
      metadata: { descricao: descricao || 'Compra', email, produto_id, bumps_ids },
    };

    const response = await axios.post(`${PUSHINPAY_BASE}/pix/cashIn`, payload, {
      headers: { Authorization: `Bearer ${PUSHINPAY_TOKEN}`, 'Content-Type': 'application/json' },
    });
    const data = response.data;

    const txs = lerJSON('transactions.json');
    txs.push({
      id:            data.id,
      nome, email, cpf,
      valor:         data.value,
      produto_id:    produto_id || null,
      bumps_ids:     bumps_ids  || [],
      status:        'pending',
      email_enviado: false,
      criado:        new Date().toISOString(),
    });
    salvarJSON('transactions.json', txs);

    res.json({
      id:           data.id,
      qrcode:       data.qr_code,
      qrcode_image: data.qr_code_base64,
      status:       data.status,
      valor:        data.value,
    });
  } catch (err) {
    const msg = err.response?.data || err.message;
    console.error('Erro PushinPay:', msg);
    res.status(500).json({ erro: 'Erro ao criar cobrança.', detalhe: msg });
  }
});

// ── Status ─────────────────────────────────────────────────────────
app.get('/api/status/:id', async (req, res) => {
  try {
    const r = await axios.get(`${PUSHINPAY_BASE}/transactions/${req.params.id}`, {
      headers: { Authorization: `Bearer ${PUSHINPAY_TOKEN}` },
    });
    res.json({ id: r.data.id, status: r.data.status });
  } catch { res.status(500).json({ erro: 'Erro ao consultar status.' }); }
});

// ── Webhook ────────────────────────────────────────────────────────
app.post('/webhook', async (req, res) => {
  const evento = req.body;
  console.log('📩 Webhook recebido:', JSON.stringify(evento, null, 2));

  const tipo  = evento.event || evento.type;
  const t     = evento.transaction || evento;
  const txId  = t.id || evento.id;
  const pago  = ['transaction.paid','PAYMENT_RECEIVED','paid'].includes(tipo) || t.status === 'paid';

  if (pago) {
    const txs     = lerJSON('transactions.json');
    const idx     = txs.findIndex(tx => tx.id === txId);
    if (idx !== -1 && txs[idx].status !== 'paid') {
      txs[idx].status  = 'paid';
      txs[idx].pago_em = new Date().toISOString();
      marcarLeadConvertido(txs[idx].email);
      const produtos   = lerJSON('products.json');
      const bumps      = lerJSON('orderbumps.json');

      // 1. Enviar produto principal
      if (txs[idx].produto_id) {
        const prod = produtos.find(p => p.id === txs[idx].produto_id);
        if (prod) {
          try {
            await enviarProduto(txs[idx], prod, false);
            txs[idx].email_enviado = true;
            console.log(`📧 Produto principal enviado para ${txs[idx].email}`);
          } catch (e) { console.error('Erro email produto:', e.message); }
        }
      }

      // 2. Enviar order bumps
      for (const bumpId of (txs[idx].bumps_ids || [])) {
        const bump = bumps.find(b => b.id === bumpId);
        if (!bump) continue;
        // Usa produto vinculado ou dados diretos do bump
        const entrega = bump.produto_id
          ? produtos.find(p => p.id === bump.produto_id)
          : {
              nome:          bump.titulo,
              link_entrega:  bump.link_entrega,
              arquivo_path:  bump.arquivo_path,
              arquivo_nome:  bump.arquivo_nome,
              email_assunto: bump.email_assunto || `Seu bônus: ${bump.titulo}`,
              email_corpo:   bump.email_corpo,
              email_remetente: '',
            };
        if (entrega) {
          try {
            await enviarProduto(txs[idx], entrega, true);
            console.log(`🎁 Bump "${bump.titulo}" enviado para ${txs[idx].email}`);
          } catch (e) { console.error('Erro email bump:', e.message); }
        }
      }

      salvarJSON('transactions.json', txs);
    }
  }
  res.status(200).json({ received: true });
});

app.get('/c/:id', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

const PORT = process.env.PORT || 3462;
app.listen(PORT, () => console.log(`🚀 http://localhost:${PORT}\n👤 Admin: http://localhost:${PORT}/admin`));
