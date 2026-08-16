const { randomUUID } = require('crypto')

const queue = []

function addJob(storeId, orderData) {
  const job = {
    token: randomUUID(),
    storeId,
    orderData,
    rawBuffer: null,
    contentType: null,
    createdAt: new Date(),
    fetched: false,
    done: false,
  }
  queue.push(job)
  console.log(`[CloudPRNT] 新增列印工作 token=${job.token} storeId=${storeId}`)
  return job
}

function addRawJob(storeId, buffer, contentType) {
  const job = {
    token: randomUUID(),
    storeId,
    orderData: null,
    rawBuffer: buffer,
    contentType,
    createdAt: new Date(),
    fetched: false,
    done: false,
  }
  queue.push(job)
  console.log(`[CloudPRNT] 新增測試工作 token=${job.token} contentType=${contentType}`)
  return job
}

function getPendingJob(storeId) {
  return queue.find(j => !j.fetched && !j.done && j.storeId === storeId) || null
}

function markJobFetched(token) {
  const job = getJobByToken(token)
  if (job) job.fetched = true
}

function getJobByToken(token) {
  return queue.find(j => j.token === token) || null
}

function markJobDone(token) {
  const job = getJobByToken(token)
  if (job) {
    job.done = true
    console.log(`[CloudPRNT] 列印完成 token=${token}`)
  }
}

// 每 10 分鐘清理已完成或超過 1 小時的舊工作。.unref() 是因為這個 timer 在
// module load 當下就註冊了（沒有掛在某個「啟動伺服器」的函式底下），如果不
// unref，任何只是 require 到這個檔案（哪怕只是為了 orderController.js 用到
// 的 addJob）、跑完就該結束的短命 script/測試 process，事件迴圈都會被這個
// timer 卡住不放，process 永遠不會自然結束——實際踩過：測試檔案只是多 require
// 了 orderController.js，就讓那個測試 process 卡了超過一小時退不出來
const cleanupInterval = setInterval(() => {
  const cutoff = Date.now() - 60 * 60 * 1000
  const before = queue.length
  queue.splice(0, queue.length,
    ...queue.filter(j => !j.done || j.createdAt.getTime() > cutoff)
  )
  if (before !== queue.length) {
    console.log(`[CloudPRNT] 清理佇列，移除 ${before - queue.length} 筆`)
  }
}, 10 * 60 * 1000)
cleanupInterval.unref()

module.exports = { addJob, addRawJob, getPendingJob, getJobByToken, markJobFetched, markJobDone }
