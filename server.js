const express = require('express');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const Anthropic = require('@anthropic-ai/sdk');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// File upload config for skill import
const upload = multer({
  dest: path.join(__dirname, 'uploads'),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
});

// ============ API Routes ============

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: Date.now() });
});

// Chat — auto-detect API format from base URL
app.post('/api/chat', async (req, res) => {
  try {
    const {
      messages, skills,
      thirdApiKey, thirdApiBase, thirdApiModel
    } = req.body;

    if (!thirdApiKey) {
      return res.status(400).json({ error: '请提供 API Key' });
    }
    if (!thirdApiBase) {
      return res.status(400).json({ error: '请提供 API Base URL' });
    }

    // DEBUG: log key to confirm what's being sent
    console.log('>>> API Key received:', thirdApiKey.slice(0, 7) + '...' + thirdApiKey.slice(-4));
    console.log('>>> API Base:', thirdApiBase);
    console.log('>>> API Model:', thirdApiModel);

    // Build system content from loaded skills
    let systemContent = '';
    if (skills && skills.length > 0) {
      const skillsContext = skills
        .map(s => `<skill name="${s.name}">\n${s.content}\n</skill>`)
        .join('\n\n');
      systemContent = `<loaded_skills>\n${skillsContext}\n</loaded_skills>\n\n---\n以上是你的可用技能。当用户指令匹配某技能时，严格按照该技能的指令执行。`;
    }

    // Auto-detect: /anthropic path → Anthropic Messages API, otherwise → OpenAI chat/completions
    const isAnthropicFormat = thirdApiBase.includes('/anthropic');

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    if (isAnthropicFormat) {
      // ── Anthropic Messages API ──────────────
      const anthropic = new Anthropic({
        apiKey: thirdApiKey,
        baseURL: thirdApiBase.replace(/\/+$/, ''),
      });

      const systemMessages = messages
        .filter(m => m.role === 'system')
        .map(m => ({ type: 'text', text: m.content }));

      const allSystem = [
        ...(systemContent ? [{ type: 'text', text: systemContent }] : []),
        ...systemMessages,
      ];

      const conversationMessages = messages
        .filter(m => m.role !== 'system')
        .map(m => ({
          role: m.role === 'assistant' ? 'assistant' : 'user',
          content: m.content,
        }));

      const stream = await anthropic.messages.stream({
        model: thirdApiModel || 'claude-sonnet-4-6',
        max_tokens: 4096,
        system: allSystem.length > 0 ? allSystem : undefined,
        messages: conversationMessages,
      });

      for await (const event of stream) {
        if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
          res.write(`data: ${JSON.stringify({ type: 'text', text: event.delta.text })}\n\n`);
        }
      }

      const finalMessage = await stream.finalMessage();
      const usage = finalMessage.usage;
      res.write(`data: ${JSON.stringify({
        type: 'done',
        usage: { input_tokens: usage.input_tokens, output_tokens: usage.output_tokens },
      })}\n\n`);
      res.end();

    } else {
      // ── OpenAI chat/completions ─────────────
      const openaiMessages = [];
      if (systemContent) {
        openaiMessages.push({ role: 'system', content: systemContent });
      }
      messages
        .filter(m => m.role !== 'system')
        .forEach(m => {
          openaiMessages.push({
            role: m.role === 'assistant' ? 'assistant' : 'user',
            content: m.content,
          });
        });

      const apiUrl = thirdApiBase.replace(/\/+$/, '') + '/chat/completions';

      const response = await fetch(apiUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${thirdApiKey}`,
        },
        body: JSON.stringify({
          model: thirdApiModel || 'gpt-4o',
          messages: openaiMessages,
          stream: true,
          max_tokens: 4096,
        }),
        signal: req.signal,
      });

      if (!response.ok) {
        const errText = await response.text();
        throw new Error(`API 错误 (${response.status}): ${errText}`);
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let totalInputTokens = 0;
      let totalOutputTokens = 0;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || !trimmed.startsWith('data: ')) continue;
          const dataStr = trimmed.slice(6);
          if (dataStr === '[DONE]') continue;

          try {
            const data = JSON.parse(dataStr);
            const choice = data.choices?.[0];
            if (choice?.delta?.content) {
              res.write(`data: ${JSON.stringify({ type: 'text', text: choice.delta.content })}\n\n`);
            }
            if (data.usage) {
              totalInputTokens = data.usage.prompt_tokens || 0;
              totalOutputTokens = data.usage.completion_tokens || 0;
            }
          } catch (_) {}
        }
      }

      res.write(`data: ${JSON.stringify({
        type: 'done',
        usage: { input_tokens: totalInputTokens, output_tokens: totalOutputTokens },
      })}\n\n`);
      res.end();
    }

  } catch (error) {
    console.error('Chat error:', error);
    if (!res.headersSent) {
      res.status(500).json({ error: error.message });
    } else {
      res.write(`data: ${JSON.stringify({ type: 'error', error: error.message })}\n\n`);
      res.end();
    }
  }
});

// List available models
app.get('/api/models', (req, res) => {
  res.json({
    models: [
      { id: 'gpt-4o', name: 'GPT-4o (OpenAI)', description: 'OpenAI 最新模型' },
      { id: 'gpt-4o-mini', name: 'GPT-4o Mini', description: '轻量快速' },
      { id: 'deepseek-chat', name: 'DeepSeek V3', description: 'DeepSeek 对话模型' },
      { id: 'qwen-plus', name: '通义千问 Plus', description: '阿里云通义千问' },
    ],
  });
});

// ── Built-in skills ──────────────────────────────
// List skills from the /skills/ directory
app.get('/api/skills/builtin', (req, res) => {
  try {
    const skillsDir = path.join(__dirname, 'skills');
    if (!fs.existsSync(skillsDir)) {
      return res.json({ skills: [] });
    }

    const files = fs.readdirSync(skillsDir).filter(f => f.endsWith('.md'));
    const skills = files.map(fileName => {
      const content = fs.readFileSync(path.join(skillsDir, fileName), 'utf-8');
      const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
      let name = fileName.replace(/\.md$/, '');
      let description = '';
      let skillContent = content;

      if (frontmatterMatch) {
        const fm = frontmatterMatch[1];
        skillContent = frontmatterMatch[2];
        const nm = fm.match(/name:\s*(.+)/);
        const dm = fm.match(/description:\s*(.+)/);
        if (nm) name = nm[1].trim();
        if (dm) description = dm[1].trim();
      }

      return { name, description, content: skillContent.trim(), builtin: true };
    });

    res.json({ skills });
  } catch (error) {
    console.error('Built-in skills error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Import skill from file upload
app.post('/api/skills/import', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: '请上传文件' });
    }

    const filePath = req.file.path;
    const content = fs.readFileSync(filePath, 'utf-8');
    const fileName = req.file.originalname;

    const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
    let name = fileName.replace(/\.(md|txt)$/i, '');
    let description = '';
    let skillContent = content;

    if (frontmatterMatch) {
      const frontmatter = frontmatterMatch[1];
      skillContent = frontmatterMatch[2];
      const nameMatch = frontmatter.match(/name:\s*(.+)/);
      const descMatch = frontmatter.match(/description:\s*(.+)/);
      if (nameMatch) name = nameMatch[1].trim();
      if (descMatch) description = descMatch[1].trim();
    }

    fs.unlinkSync(filePath);

    res.json({
      name,
      description,
      content: skillContent.trim(),
      raw: content,
      importedAt: new Date().toISOString(),
    });
  } catch (error) {
    console.error('Import error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Import skill from text
app.post('/api/skills/import-text', (req, res) => {
  try {
    const { text, fileName } = req.body;
    if (!text) return res.status(400).json({ error: '请提供文本内容' });

    const frontmatterMatch = text.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
    let name = (fileName || 'custom').replace(/\.(md|txt)$/i, '');
    let description = '';
    let skillContent = text;

    if (frontmatterMatch) {
      const frontmatter = frontmatterMatch[1];
      skillContent = frontmatterMatch[2];
      const nameMatch = frontmatter.match(/name:\s*(.+)/);
      const descMatch = frontmatter.match(/description:\s*(.+)/);
      if (nameMatch) name = nameMatch[1].trim();
      if (descMatch) description = descMatch[1].trim();
    }

    res.json({
      name,
      description,
      content: skillContent.trim(),
      raw: text,
      importedAt: new Date().toISOString(),
    });
  } catch (error) {
    console.error('Import text error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Import skills from directory (batch)
app.post('/api/skills/import-directory', (req, res) => {
  try {
    const { files } = req.body;
    if (!files || !Array.isArray(files)) {
      return res.status(400).json({ error: '请提供文件列表' });
    }

    const skills = files.map(f => {
      const frontmatterMatch = f.content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
      let name = f.name.replace(/\.(md|txt)$/i, '');
      let description = '';
      let skillContent = f.content;

      if (frontmatterMatch) {
        const fm = frontmatterMatch[1];
        skillContent = frontmatterMatch[2];
        const nm = fm.match(/name:\s*(.+)/);
        const dm = fm.match(/description:\s*(.+)/);
        if (nm) name = nm[1].trim();
        if (dm) description = dm[1].trim();
      }

      return { name, description, content: skillContent.trim(), raw: f.content };
    });

    res.json({ skills, count: skills.length });
  } catch (error) {
    console.error('Batch import error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Start server
app.listen(PORT, () => {
  console.log(`🤖 AI Chat Mobile running at http://localhost:${PORT}`);
  console.log(`📱 Open in your browser to use`);
  console.log(`🔑 Configure third-party API in Settings`);
  console.log(`📂 Import skills via the skills panel`);
  console.log(`📦 Built-in skills: ${fs.existsSync(path.join(__dirname, 'skills')) ? fs.readdirSync(path.join(__dirname, 'skills')).filter(f => f.endsWith('.md')).length : 0} loaded`);
});
