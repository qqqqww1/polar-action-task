// check-factorio-version.js
const axios = require("axios");
const qiniu = require("qiniu");
const fs = require("fs");
const path = require("path");

require("dotenv").config();

// 七牛云配置
const qiniuConfig = {
  accessKey: process.env.QINIU_ACCESS_KEY,
  secretKey: process.env.QINIU_SECRET_KEY,
  bucket: process.env.QINIU_BUCKET,
  domain: process.env.QINIU_DOMAIN,
};

// 初始化七牛云客户端
const mac = new qiniu.auth.digest.Mac(
  qiniuConfig.accessKey,
  qiniuConfig.secretKey
);
const config = new qiniu.conf.Config();
config.zone = qiniu.zone.Zone_z0;

// 七牛云存储相关函数
async function getCurrentVersion () {
  try {
    const bucketManager = new qiniu.rs.BucketManager(mac, config);
    const key = "factorio/current-version.txt";

    return new Promise((resolve, reject) => {
      bucketManager.stat(qiniuConfig.bucket, key, (err, respBody, respInfo) => {
        if (err) {
          resolve("");
          return;
        }

        const publicUrl = `http://${qiniuConfig.domain}/${key}`;
        console.log("开始从七牛云获取版本信息", publicUrl);

        axios
          .get(publicUrl)
          .then((response) => resolve(response.data.trim()))
          .catch(() => resolve(""));
      });
    });
  } catch (error) {
    console.error("获取当前版本出错:", error);
    return "";
  }
}

async function uploadToQiniu(localFile, key) {
  // 先删除已存在的文件
  const bucketManager = new qiniu.rs.BucketManager(mac, config);
  try {
    await new Promise((resolve, reject) => {
      bucketManager.delete(qiniuConfig.bucket, key, (err, respBody, respInfo) => {
        if (err) {
          console.warn(`删除文件失败: ${err}`);
        }
        resolve();
      });
    });
  } catch (error) {
    console.warn(`删除文件出错: ${error}`);
  }

  // 上传新文件
  const putPolicy = new qiniu.rs.PutPolicy({
    scope: qiniuConfig.bucket + ":" + key,
    insertOnly: 0
  });
  const uploadToken = putPolicy.uploadToken(mac);
  const formUploader = new qiniu.form_up.FormUploader(config);
  const putExtra = new qiniu.form_up.PutExtra();

  return new Promise((resolve, reject) => {
    formUploader.putFile(
      uploadToken,
      key,
      localFile,
      putExtra,
      (err, body, info) => {
        if (err) {
          reject(err);
          return;
        }
        if (info.statusCode === 200) {
          resolve(body);
        } else {
          reject(new Error(`上传失败，状态码: ${info.statusCode}`));
        }
      }
    );
  });
}

async function updateVersionFile (version) {
  const tempFile = "temp-version.txt";
  fs.writeFileSync(tempFile, version);

  try {
    await uploadToQiniu(tempFile, "factorio/current-version.txt");
  } finally {
    fs.unlinkSync(tempFile);
  }
}

// 下载相关函数
async function downloadFactorio (version) {
  const downloadUrl = `https://www.factorio.com/get-download/${version}/headless/linux64`;
  const fileName = `factorio-${version}.tar.xz`;

  const response = await axios({
    method: "get",
    url: downloadUrl,
    responseType: "stream",
  });

  const totalLength = response.headers["content-length"];
  console.log(
    "开始下载文件，总大小:",
    (totalLength / 1024 / 1024).toFixed(2),
    "MB"
  );

  let downloadedLength = 0;
  response.data.on("data", (chunk) => {
    downloadedLength += chunk.length;
    const progress = ((downloadedLength / totalLength) * 100).toFixed(2);
    process.stdout.write(`下载进度: ${progress}%\r`);
  });

  const writer = fs.createWriteStream(fileName);
  response.data.pipe(writer);

  await new Promise((resolve, reject) => {
    writer.on("finish", resolve);
    writer.on("error", reject);
  });

  return fileName;
}

// 主函数
async function checkAndUpdateVersion () {
  try {
    // 获取版本信息
    const versionResponse = await axios.get(
      "https://factorio.com/api/latest-releases"
    );
    const latestStable = versionResponse.data.stable.headless;
    const currentVersion = await getCurrentVersion();

    console.log("当前版本:", currentVersion);
    console.log("最新版本:", latestStable);

    if (currentVersion === latestStable) {
      console.log("当前已是最新版本");
      return;
    }

    console.log(`发现新版本: ${latestStable}`);

    // 下载新版本
    const fileName = await downloadFactorio(latestStable);

    try {
      // 上传到七牛云
      console.log("开始上传文件到七牛云");
      await uploadToQiniu(fileName, "factorio/latest.tar.xz");
      console.log("文件上传成功");

      // 更新版本记录
      await updateVersionFile(latestStable);
      console.log("版本文件已更新");
    } finally {
      // 清理下载的文件
      fs.unlinkSync(fileName);
      console.log("清理下载文件完成");
    }
  } catch (error) {
    console.error("更新过程出错:", error);
    process.exit(1);
  }
}

checkAndUpdateVersion();
