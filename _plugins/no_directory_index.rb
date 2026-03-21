# Prevent directory listing by adding index.html redirects
# to any output directory that doesn't already have one.
Jekyll::Hooks.register :site, :post_write do |site|
  redirect = '<!DOCTYPE html><html><head><meta http-equiv="refresh" content="0;url=/"></head><body></body></html>'
  Dir.glob(File.join(site.dest, '**', '*')).select { |f| File.directory?(f) }.each do |dir|
    index = File.join(dir, 'index.html')
    File.write(index, redirect) unless File.exist?(index)
  end
end
