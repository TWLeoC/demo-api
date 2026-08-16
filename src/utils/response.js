const success = (res, data = null, message = 'success', statusCode = 200) => {
  const payload = { success: true, message }
  if (data !== null) payload.data = data
  return res.status(statusCode).json(payload)
}

const error = (res, message = 'Internal server error', statusCode = 500, errors = null) => {
  const payload = { success: false, message }
  if (errors) payload.errors = errors
  return res.status(statusCode).json(payload)
}

const paginate = (res, data, total, page, limit) => {
  return res.status(200).json({
    success: true,
    message: 'success',
    data,
    pagination: {
      total,
      page: Number(page),
      limit: Number(limit),
      totalPages: Math.ceil(total / limit)
    }
  })
}

module.exports = { success, error, paginate }
