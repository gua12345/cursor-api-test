const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { stringToHex, chunkToUtf8String, getRandomIDPro } = require('./utils.js');
const app = express();

// 中间件配置
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.post('/v1/chat/completions', async (req, res) => {
  let currentKeyIndex = 0;
  try {
    const { model, messages, stream = false } = req.body;
    let authToken = req.headers.authorization?.replace('Bearer ', '');
    // 处理逗号分隔的密钥
    const keys = authToken.split(',').map((key) => key.trim());
    if (keys.length > 0) {
      // 确保 currentKeyIndex 不会越界
      if (currentKeyIndex >= keys.length) {
        currentKeyIndex = 0;
      }
      // 使用当前索引获取密钥
      authToken = keys[currentKeyIndex];
    }
    if (authToken && authToken.includes('%3A%3A')) {
      authToken = authToken.split('%3A%3A')[1];
    }
    if (!messages || !Array.isArray(messages) || messages.length === 0 || !authToken) {
      return res.status(400).json({
        error: 'Invalid request. Messages should be a non-empty array and authorization is required',
      });
    }

    const hexData = await stringToHex(messages, model);

    // 获取checksum，req header中传递优先，环境变量中的等级第二，最后随机生成
    const checksum =
      req.headers['x-cursor-checksum'] ??
      process.env['x-cursor-checksum'] ??
      `zo${getRandomIDPro({ dictType: 'max', size: 6 })}${getRandomIDPro({ dictType: 'max', size: 64 })}/${getRandomIDPro({ dictType: 'max', size: 64 })}`;

    const response = await fetch('https://api2.cursor.sh/aiserver.v1.AiService/StreamChat', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/connect+proto',
        authorization: `Bearer ${authToken}`,
        'connect-accept-encoding': 'gzip,br',
        'connect-protocol-version': '1',
        'user-agent': 'connect-es/1.4.0',
        'x-amzn-trace-id': `Root=${uuidv4()}`,
        'x-cursor-checksum': checksum,
        'x-cursor-client-version': '0.42.3',
        'x-cursor-timezone': 'Asia/Shanghai',
        'x-ghost-mode': 'false',
        'x-request-id': uuidv4(),
        Host: 'api2.cursor.sh',
      },
      body: hexData,
    });

    if (stream) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');

      const responseId = `chatcmpl-${uuidv4()}`;

      let text = '';
      // 非流式获取完整响应
      for await (const chunk of response.body) {
        text += await chunkToUtf8String(chunk);
      }

      // 对文本进行预处理（如果需要）
      text = text.replace(/^.*<\|END_USER\|>/s, '');
      text = text.replace(/^\n[a-zA-Z]?/, '').trim();

      // 将文本拆分为小块，模拟流式输出
      const chunkSize = 50; // 每个块的大小，可以根据需要调整
      for (let i = 0; i < text.length; i += chunkSize) {
        const chunkText = text.slice(i, i + chunkSize);
        res.write(
          `data: ${JSON.stringify({
            id: responseId,
            object: 'chat.completion.chunk',
            created: Math.floor(Date.now() / 1000),
            model,
            choices: [
              {
                index: 0,
                delta: {
                  content: chunkText,
                },
              },
            ],
          })}\n\n`,
        );
        // 可选：添加延迟以模拟真实的流式响应
        await new Promise((resolve) => setTimeout(resolve, 50));
      }

      res.write('data: [DONE]\n\n');
      return res.end();
    } else {
      // 非流式模式，保持原样
      let text = '';
      for await (const chunk of response.body) {
        text += await chunkToUtf8String(chunk);
      }
      text = text.replace(/^.*<\|END_USER\|>/s, '');
      text = text.replace(/^\n[a-zA-Z]?/, '').trim();

      return res.json({
        id: `chatcmpl-${uuidv4()}`,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              content: text,
            },
            finish_reason: 'stop',
          },
        ],
        usage: {
          prompt_tokens: 0,
          completion_tokens: 0,
          total_tokens: 0,
        },
      });
    }
  } catch (error) {
    console.error('Error:', error);
    if (!res.headersSent) {
      if (req.body.stream) {
        res.write(`data: ${JSON.stringify({ error: 'Internal server error' })}\n\n`);
        return res.end();
      } else {
        return res.status(500).json({ error: 'Internal server error' });
      }
    }
  }
});

// 启动服务器
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`服务器运行在端口 ${PORT}`);
});
