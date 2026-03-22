const express = require('express');
const multer = require('multer');
const sharp = require('sharp');
const cors = require('cors');
const path = require('path');
const tinify = require('tinify');

const app = express();
app.use(cors()); 
const upload = multer({ storage: multer.memoryStorage() });

// 统一的图像处理接口
app.post('/process-image', upload.single('image'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).send('No file uploaded.');

    const quality = parseInt(req.body.quality) || 80;
    const format = req.body.format; // "JPG", "PNG"
    const colorMode = req.body.colorMode; // "RGB", "CMYK"
    const apiKey = req.body.apiKey; // 接收用户从前端传来的 API Key

    let processedImageBuffer;

    // 分支 1：专业印前 CMYK JPG (依然免费、极速、无额度限制)
    if (format === 'JPG' && colorMode === 'CMYK') {
      const iccProfilePath = path.join(__dirname, 'CoatedFOGRA39.icc'); 
      processedImageBuffer = await sharp(req.file.buffer)
        .toColorspace('cmyk')
        .withIccProfile(iccProfilePath)
        .jpeg({ quality: quality })
        .toBuffer();
      
      res.type('image/jpeg');
      console.log(`✅ [Sharp] 成功转换 CMYK JPG`);
    } 
    
    // 分支 2：用户勾选了 Panda 并且提供了 API Key
    else if (apiKey && apiKey.trim() !== '') {
      console.log(`🐼 正在使用用户的 Panda Key 压缩 ${format}...`);
      tinify.key = apiKey.trim(); // 动态挂载当前用户的 Key
      
      try {
        processedImageBuffer = await new Promise((resolve, reject) => {
          tinify.fromBuffer(req.file.buffer).toBuffer((err, resultData) => {
            if (err) reject(err);
            else resolve(resultData);
          });
        });
        
        res.type(format === 'JPG' ? 'image/jpeg' : 'image/png');
        console.log(`✅ [Panda] 压缩成功！该用户本月已用额度: ${tinify.compressionCount}/500`);
      } catch (tinifyErr) {
        console.error("❌ Panda API 拒绝了请求:", tinifyErr.message);
        return res.status(401).send("Panda 压缩失败，可能是 API Key 无效或额度超限。");
      }
    } 
    
    // 分支 3：纯本地降级方案 (用户没填 Key，或者走普通的 RGB 导出)
    else {
      if (format === 'JPG') {
        processedImageBuffer = await sharp(req.file.buffer).jpeg({ quality: quality }).toBuffer();
        res.type('image/jpeg');
      } else {
        // PNG 如果没有 Panda 压缩，就直接返回原图（无损）
        processedImageBuffer = req.file.buffer; 
        res.type('image/png');
      }
    }

    res.send(processedImageBuffer);

  } catch (error) {
    console.error('❌ 服务器全局错误:', error);
    res.status(500).send(error.message);
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 终极图像引擎已启动，端口: ${PORT}`);
});
