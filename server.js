const express = require('express');
const multer = require('multer');
const sharp = require('sharp');
const cors = require('cors');
const path = require('path');

const app = express();
app.use(cors()); 
const upload = multer({ storage: multer.memoryStorage() });

app.post('/convert-cmyk', upload.single('image'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).send('No file uploaded.');
    const quality = parseInt(req.body.quality) || 80;

    // 🌟 核心：挂载全行业最通用的 ISO 标准 ICC 文件
    // 请确保你已经把 'CoatedFOGRA39.icc' 放到了当前目录下
    const iccProfilePath = path.join(__dirname, 'CoatedFOGRA39.icc'); 

    const processedImageBuffer = await sharp(req.file.buffer)
      .toColorspace('cmyk')
      .withIccProfile(iccProfilePath) // 使用通用标准进行印前色彩映射和 UCR/GCR 处理
      .jpeg({ quality: quality })
      .toBuffer();

    res.type('image/jpeg').send(processedImageBuffer);
    console.log(`✅ 成功使用 FOGRA39 通用标准转换 CMYK，质量: ${quality}%`);
  } catch (error) {
    console.error('转换失败:', error);
    res.status(500).send(error.message);
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 专业 CMYK 转换服务已启动，端口: 3000`);
  console.log(`已挂载通用 ISO 标准色彩引擎，等待请求...`);
});