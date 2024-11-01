// check-factorio-version.js
const axios = require("axios");
const qiniu = require("qiniu");
const fs = require("fs");
const path = require("path");

require("dotenv").config();
// 配置七牛云认证信息
const accessKey = process.env.QINIU_ACCESS_KEY;
const secretKey = process.env.QINIU_SECRET_KEY;
const bucket = process.env.QINIU_BUCKET;
const domain = process.env.QINIU_DOMAIN;

const mac = new qiniu.auth.digest.Mac(accessKey, secretKey);
const config = new qiniu.conf.Config();
// 根据你的七牛云存储区域进行配置
config.zone = qiniu.zone.Zone_z0;

// 使用七牛云存储版本信息
async function getCurrentVersion() {
  try {
    const bucketManager = new qiniu.rs.BucketManager(mac, config);
    const key = "factorio/current-version.txt";

    return new Promise((resolve, reject) => {
      bucketManager.stat(bucket, key, (err, respBody, respInfo) => {
        if (err) {
          resolve(""); // 如果文件不存在，返回空字符串
          return;
        }

        // 下载版本文件
        const publicUrl = `http://${domain}/${key}`;

        console.log("开始从七牛云获取版本信息", publicUrl);
        axios
          .get(publicUrl)
          .then((response) => resolve(response.data.trim()))
          .catch(() => resolve(""));
      });
    });
  } catch (error) {
    console.error("Error getting current version:", error);
    return "";
  }
}

async function updateVersionFile(version) {
  const putPolicy = new qiniu.rs.PutPolicy({
    scope: bucket,
  });
  const uploadToken = putPolicy.uploadToken(mac);
  const formUploader = new qiniu.form_up.FormUploader(config);
  const putExtra = new qiniu.form_up.PutExtra();

  // 创建临时版本文件
  const tempFile = "temp-version.txt";
  fs.writeFileSync(tempFile, version);

  // 上传到七牛云
  const key = "factorio/current-version.txt";

  return new Promise((resolve, reject) => {
    formUploader.putFile(
      uploadToken,
      key,
      tempFile,
      putExtra,
      function (err, body, info) {
        // 清理临时文件
        fs.unlinkSync(tempFile);

        if (err) {
          reject(err);
          return;
        }
        if (info.statusCode == 200) {
          resolve(body);
        } else {
          reject(new Error(`Upload failed with status: ${info.statusCode}`));
        }
      }
    );
  });
}

async function checkAndUpdateVersion() {
  try {
    // 获取最新版本信息
    const versionResponse = await axios.get(
      "https://factorio.com/api/latest-releases"
    );
    const latestStable = versionResponse.data.stable.headless;

    // 从七牛云获取当前版本
    const currentVersion = await getCurrentVersion();
    console.log("Current version:", currentVersion);
    console.log("Latest version:", latestStable);

    // 检查是否有更新
    if (currentVersion !== latestStable) {
      console.log(`New version detected: ${latestStable}`);

      // 下载新版本
      const downloadUrl = `https://www.factorio.com/get-download/${latestStable}/headless/linux64`;
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

      let count = 0;
      let downloadedLength = 0;
      response.data.on("data", (chunk) => {
        downloadedLength += chunk.length;
        const progress = ((downloadedLength / totalLength) * 100).toFixed(2);

        if (count % 100 === 0) {
          process.stdout.write(`下载进度: ${progress}%\r`);
        }
        count++;
      });

      const fileName = `factorio-${latestStable}.tar.xz`;
      const writer = fs.createWriteStream(fileName);

      response.data.pipe(writer);

      await new Promise((resolve, reject) => {
        writer.on("finish", resolve);
        writer.on("error", reject);
      });

      // 上传到七牛云
      console.log("开始上传文件到七牛云");
      const putPolicy = new qiniu.rs.PutPolicy({
        scope: bucket,
      });
      const uploadToken = putPolicy.uploadToken(mac);
      const formUploader = new qiniu.form_up.FormUploader(config);
      const putExtra = new qiniu.form_up.PutExtra();

      const key = `factorio/latest.tar.xz`;

      await new Promise((resolve, reject) => {
        formUploader.putFile(
          uploadToken,
          key,
          fileName,
          putExtra,
          function (err, body, info) {
            if (err) {
              reject(err);
              return;
            }
            if (info.statusCode == 200) {
              console.log("Upload successful");
              resolve(body);
            } else {
              reject(
                new Error(`Upload failed with status: ${info.statusCode}`)
              );
            }
          }
        );
      });

      // 更新版本记录到七牛云
      await updateVersionFile(latestStable);
      console.log("Version file updated");

      // 清理下载的文件
      fs.unlinkSync(fileName);
      console.log("Cleaned up downloaded file");
    } else {
      console.log("No new version available");
    }
  } catch (error) {
    console.error("Error:", error);
    process.exit(1);
  }
}

checkAndUpdateVersion();
