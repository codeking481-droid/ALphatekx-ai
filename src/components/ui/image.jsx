import * as React from "react"

const FALLBACK_IMAGE_URL =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='640' height='400' viewBox='0 0 640 400'%3E%3Crect width='640' height='400' fill='%23e5e7eb'/%3E%3Cpath d='M240 250l65-75 50 55 38-42 75 82H172z' fill='%239ca3af'/%3E%3Ccircle cx='410' cy='125' r='24' fill='%239ca3af'/%3E%3C/svg%3E"

export const Image = React.forwardRef(({ src, onError, ...props }, ref) => {
  const [failedSource, setFailedSource] = React.useState(null)
  const displayedSource = failedSource === src ? FALLBACK_IMAGE_URL : src || FALLBACK_IMAGE_URL

  return (
    <img
      ref={ref}
      src={displayedSource}
      onError={(event) => {
        if (failedSource !== src) setFailedSource(src)
        onError?.(event)
      }}
      {...props}
    />
  )
})
Image.displayName = "Image"
