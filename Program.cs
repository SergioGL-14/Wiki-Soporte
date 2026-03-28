using Ganss.Xss;
using Microsoft.AspNetCore.Diagnostics;
using Microsoft.Extensions.FileProviders;
using WikiProto.Services;
using WikiProto.Models;
using WikiPage = WikiProto.Models.Page;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Text.RegularExpressions;
using Microsoft.AspNetCore.ResponseCompression;

var builder = WebApplication.CreateBuilder(args);

// Add services (removed RazorPages - using only SPA)
builder.Services.AddSingleton<PageService>();
builder.Services.AddSingleton<CategoriesService>();
builder.Services.AddSingleton<NoticesService>();
builder.Services.AddSingleton<IncidentsService>();

// Configure JSON serialization
builder.Services.ConfigureHttpJsonOptions(options =>
{
    options.SerializerOptions.PropertyNamingPolicy = JsonNamingPolicy.CamelCase;
    options.SerializerOptions.DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull;
    options.SerializerOptions.Converters.Add(new JsonStringEnumConverter());
});

// Add response caching for better multi-user performance
builder.Services.AddResponseCaching();
builder.Services.AddResponseCompression(options =>
{
    options.EnableForHttps = true;
    options.MimeTypes = ResponseCompressionDefaults.MimeTypes.Concat(new[]
    {
        "application/json",
        "application/javascript"
    });
});

// Add memory cache for better performance in multi-user scenarios
builder.Services.AddMemoryCache();

var app = builder.Build();

// Ensure DB and tables exist
var pageSvc = app.Services.GetRequiredService<PageService>();
pageSvc.Initialize();

// Initialize notices table/service
var noticesSvc = app.Services.GetRequiredService<NoticesService>();
noticesSvc.Initialize();
 
// Initialize incidents service and DB
var incidentsSvc = app.Services.GetRequiredService<IncidentsService>();
incidentsSvc.Initialize();

if (!app.Environment.IsDevelopment())
{
    app.UseExceptionHandler(errorApp =>
    {
        errorApp.Run(async context =>
        {
            var exceptionFeature = context.Features.Get<IExceptionHandlerPathFeature>();
            var logger = context.RequestServices
                .GetRequiredService<ILoggerFactory>()
                .CreateLogger("GlobalExceptionHandler");

            if (exceptionFeature?.Error != null)
            {
                logger.LogError(
                    exceptionFeature.Error,
                    "Unhandled exception while processing {Path}",
                    exceptionFeature.Path);
            }

            context.Response.StatusCode = StatusCodes.Status500InternalServerError;
            context.Response.ContentType = "application/json";

            await context.Response.WriteAsync(JsonSerializer.Serialize(new
            {
                error = "Unexpected server error.",
                path = exceptionFeature?.Path
            }));
        });
    });
}

// Enable response caching
app.UseResponseCaching();
app.UseResponseCompression();

// Serve the static-wiki folder under /wiki for the SPA frontend
var wikiPath = Path.Combine(app.Environment.ContentRootPath, "static-wiki");
if (Directory.Exists(wikiPath))
{
    // Serve default documents (index.html) from the static-wiki folder at /wiki/
    var defaultOpts = new DefaultFilesOptions
    {
        FileProvider = new PhysicalFileProvider(wikiPath),
        RequestPath = "/wiki"
    };
    defaultOpts.DefaultFileNames.Clear();
    defaultOpts.DefaultFileNames.Add("index.html");
    app.UseDefaultFiles(defaultOpts);

    app.UseStaticFiles(new StaticFileOptions
    {
        FileProvider = new PhysicalFileProvider(wikiPath),
        RequestPath = "/wiki",
        OnPrepareResponse = ctx =>
        {
            // Keep HTML always fresh, but allow light revalidation/cache for JS/CSS so IIS feels snappier.
            var ext = Path.GetExtension(ctx.File.Name).ToLowerInvariant();
            if (ext == ".html")
            {
                ctx.Context.Response.Headers["Cache-Control"] = "no-cache, must-revalidate";
            }
            else if (ext == ".js" || ext == ".css")
            {
                ctx.Context.Response.Headers["Cache-Control"] = "public, max-age=600, must-revalidate";
            }
        }
    });
}

// Serve `wwwroot/img` at /img so diagrams and other assets placed in the web root img folder are reachable
var imgPath = Path.Combine(app.Environment.ContentRootPath, "wwwroot", "img");
Directory.CreateDirectory(imgPath);
app.UseStaticFiles(new StaticFileOptions
{
    FileProvider = new PhysicalFileProvider(imgPath),
    RequestPath = "/img",
    OnPrepareResponse = ctx =>
    {
        // Some browsers treat .jfif with nonstandard mime; ensure it's served as image/jpeg when embedded
        var ext = Path.GetExtension(ctx.File.Name).ToLowerInvariant();
        if (ext == ".jfif") ctx.Context.Response.ContentType = "image/jpeg";
    }
});



app.UseStaticFiles();

// redirect root to /wiki/
app.MapGet("/", () => Results.Redirect("/wiki/"));
app.MapGet("/wiki", () => Results.Redirect("/wiki/"));

app.UseRouting();

// Minimal API endpoints for sharing a central SQLite DB
// Note: For true real-time multi-user sync, consider adding SignalR or polling mechanism

app.MapGet("/api/pages", (int? limit, long? categoryId, PageService svc) =>
{
    if (categoryId.HasValue) return Results.Ok(svc.GetByCategory(categoryId.Value));
    if (limit.HasValue) return Results.Ok(svc.GetLatest(limit.Value));
    return Results.Ok(svc.GetAll());
});

app.MapGet("/api/pages/{slug}", (string slug, PageService svc) =>
{
    var p = svc.GetBySlug(slug);
    return p == null ? Results.NotFound() : Results.Ok(p);
});

app.MapPost("/api/pages", async (HttpRequest req, PageService svc) =>
{
    try
    {
        var dto = await req.ReadFromJsonAsync<WikiPage>();
        if (dto == null) return Results.BadRequest(new { error = "Invalid page data." });
        if (string.IsNullOrWhiteSpace(dto.Title)) return Results.BadRequest(new { error = "Title is required." });
        
        // sanitize HTML on server, allowing images with data URIs (base64)
        var sanitizer = new Ganss.Xss.HtmlSanitizer();
        sanitizer.AllowedSchemes.Add("data");
        sanitizer.AllowedAttributes.Add("class");
        sanitizer.AllowedAttributes.Add("style");
        dto.HtmlContent = sanitizer.Sanitize(dto.HtmlContent ?? string.Empty);
        
        var saved = svc.CreateOrUpdate(dto, "web");
        return Results.Ok(saved);
    }
    catch (InvalidOperationException ex) when (ex.Message.Contains("slug", StringComparison.OrdinalIgnoreCase))
    {
        return Results.Conflict(new { error = ex.Message });
    }
    catch (InvalidOperationException ex)
    {
        return Results.BadRequest(new { error = ex.Message });
    }
    catch (System.Data.SQLite.SQLiteException ex) when (ex.ErrorCode == (int)System.Data.SQLite.SQLiteErrorCode.Constraint)
    {
        return Results.Conflict(new { error = "The page could not be saved due to a data constraint conflict." });
    }
    catch (Exception ex)
    {
        Console.WriteLine($"Error saving page: {ex.Message}");
        Console.WriteLine(ex.StackTrace);
        return Results.Problem(detail: ex.Message);
    }
});

app.MapGet("/api/search", (string q, PageService svc) =>
{
    if (string.IsNullOrWhiteSpace(q)) return Results.Ok(Array.Empty<WikiPage>());
    return Results.Ok(svc.Search(q));
});

app.MapDelete("/api/pages/{slug}", (string slug, PageService svc) =>
{
    try
    {
        var page = svc.GetBySlug(slug);
        if (page == null) return Results.NotFound();
        
        svc.Delete(page.Id);
        return Results.Ok(new { message = "Page deleted successfully" });
    }
    catch (Exception ex)
    {
        Console.WriteLine($"Error deleting page: {ex.Message}");
        return Results.Problem($"Error deleting page: {ex.Message}");
    }
});

app.MapGet("/api/categories", (CategoriesService svc) => Results.Ok(svc.GetAll()));

// Diagramas endpoints: listar, subir con metadatos y borrar

// Helper: normalize relative image paths in an HTML diagram file in a safe, idempotent way
static bool NormalizeDiagramHtmlFile(string dest)
{
    if (!File.Exists(dest)) return false;
    var backup = dest + ".orig";
    if (!File.Exists(backup)) File.Copy(dest, backup);
    var content = File.ReadAllText(dest);
    var original = content;

    // Normalize src attributes when they are relative and point to img/ or diagramas/img/
    content = Regex.Replace(content, "(?i)(src\\s*=\\s*)([\"'])(?!\\s*(?:/|https?:|data:|//))([^\"'>]+)\\2", m =>
    {
        var prefix = m.Groups[1].Value;
        var q = m.Groups[2].Value;
        var path = m.Groups[3].Value.Replace('\\','/');
        var p = path;
        if (p.StartsWith("diagramas/img/", StringComparison.OrdinalIgnoreCase)) p = p.Substring("diagramas/".Length);
        if (p.StartsWith("img/", StringComparison.OrdinalIgnoreCase) || p.StartsWith("./img/", StringComparison.OrdinalIgnoreCase) || p.StartsWith("../img/", StringComparison.OrdinalIgnoreCase))
        {
            p = Regex.Replace(p, "^(?:\\./|\\.\\./)+", "", RegexOptions.None);
            return prefix + q + "/" + p + q;
        }
        // If the path is a relative image (ends with image extension), resolve to root /img/ if the file exists there
        if (Regex.IsMatch(p, "(?i)\\.(png|jpe?g|jfif|gif|webp|svg)$"))
        {
            var fileName = Path.GetFileName(p);
            return prefix + q + "/img/" + fileName + q;
        }
        return m.Value;
    });

    // Normalize url(...) occurrences
    content = Regex.Replace(content, "(?i)(url\\(\\s*)(['\"]?)(?!\\s*(?:/|https?:|data:|//))([^\\)\\'\"]+)\\2\\s*\\)", m =>
    {
        var pre = m.Groups[1].Value;
        var q = m.Groups[2].Value;
        var path = m.Groups[3].Value.Replace('\\','/');
        var p = path;
        if (p.StartsWith("diagramas/img/", StringComparison.OrdinalIgnoreCase)) p = p.Substring("diagramas/".Length);
        if (p.StartsWith("img/", StringComparison.OrdinalIgnoreCase) || p.StartsWith("./img/", StringComparison.OrdinalIgnoreCase) || p.StartsWith("../img/", StringComparison.OrdinalIgnoreCase))
        {
            p = Regex.Replace(p, "^(?:\\./|\\.\\./)+", "", RegexOptions.None);
            return pre + q + "/" + p + q + ")";
        }
        if (Regex.IsMatch(p, "(?i)\\.(png|jpe?g|jfif|gif|webp|svg)$"))
        {
            var fileName = Path.GetFileName(p);
            return pre + q + "/img/" + fileName + q + ")";
        }
        return m.Value;
    });

    // Normalize srcset (comma-separated)
    content = Regex.Replace(content, "(?i)(srcset\\s*=\\s*)([\"'])([^\"']+)\\2", m =>
    {
        var pre = m.Groups[1].Value;
        var q = m.Groups[2].Value;
        var val = m.Groups[3].Value;
        var parts = val.Split(',');
        for (int i = 0; i < parts.Length; i++)
        {
            var item = parts[i].Trim();
            if (string.IsNullOrEmpty(item)) continue;
            var sp = Regex.Split(item, "\\s+");
            var url = sp[0].Replace('\\','/');
            var desc = sp.Length > 1 ? " " + string.Join(" ", sp.Skip(1)) : "";
            var p = url;
            if (p.StartsWith("diagramas/img/", StringComparison.OrdinalIgnoreCase)) p = p.Substring("diagramas/".Length);
            if (p.StartsWith("img/", StringComparison.OrdinalIgnoreCase) || p.StartsWith("./img/", StringComparison.OrdinalIgnoreCase) || p.StartsWith("../img/", StringComparison.OrdinalIgnoreCase))
            {
                p = Regex.Replace(p, "^(?:\\./|\\.\\./)+", "", RegexOptions.None);
                p = "/" + p;
            }
            else if (Regex.IsMatch(p, "(?i)\\.(png|jpe?g|jfif|gif|webp|svg)$"))
            {
                var fileName = Path.GetFileName(p);
                p = "/img/" + fileName;
            }
            parts[i] = p + desc;
        }
        var newVal = string.Join(", ", parts);
        return pre + q + newVal + q;
    });

    if (content != original)
    {
        File.WriteAllText(dest, content);
        return true;
    }
    return false;
}

app.MapGet("/api/diagramas", (IWebHostEnvironment env) =>
{
    var webRoot = env.WebRootPath ?? Path.Combine(Directory.GetCurrentDirectory(), "wwwroot");
    var dir = Path.Combine(webRoot, "diagramas");
    if (!Directory.Exists(dir)) Directory.CreateDirectory(dir);

    var files = Directory.GetFiles(dir, "*.html")
        .Select(f => {
            var fname = Path.GetFileName(f);
            var metaPath = Path.Combine(dir, fname + ".meta.json");
            string displayName = fname, description = "";
            try {
                if (File.Exists(metaPath)) {
                    var meta = JsonSerializer.Deserialize<Dictionary<string,string>>(File.ReadAllText(metaPath));
                    if (meta != null) {
                        if (meta.TryGetValue("displayName", out var dn)) displayName = dn;
                        if (meta.TryGetValue("description", out var ds)) description = ds;
                    }
                }
            } catch { }
            return new {
                file = fname,
                displayName,
                description,
                url = $"/diagramas/{fname}",
                createdAt = File.GetCreationTimeUtc(f)
            };
        })
        .OrderByDescending(x => x.createdAt)
        .ToList();

    return Results.Ok(files);
});

app.MapPost("/api/diagramas", async (HttpRequest req, IWebHostEnvironment env) =>
{
    if (!req.HasFormContentType) return Results.BadRequest("No form content");
    var form = await req.ReadFormAsync();
    var file = form.Files.FirstOrDefault();
    if (file == null || string.IsNullOrEmpty(file.FileName)) return Results.BadRequest("No file");

    var displayName = form["displayName"].FirstOrDefault() ?? file.FileName;
    var description = form["description"].FirstOrDefault() ?? "";

    var webRoot = env.WebRootPath ?? Path.Combine(Directory.GetCurrentDirectory(), "wwwroot");
    var dir = Path.Combine(webRoot, "diagramas");
    Directory.CreateDirectory(dir);

    var safeName = $"{DateTime.UtcNow.Ticks}_{Path.GetFileName(file.FileName)}";
    var dest = Path.Combine(dir, safeName);
    using (var fs = File.Create(dest))
    {
        await file.CopyToAsync(fs);
    }

    // If HTML, normalize relative image references using the central helper
    if (string.Equals(Path.GetExtension(dest), ".html", StringComparison.OrdinalIgnoreCase))
    {
        try { NormalizeDiagramHtmlFile(dest); } catch (Exception ex) { Console.WriteLine($"Error normalizing diagram HTML: {ex.Message}"); }
    }

    var meta = new Dictionary<string,string> {
        ["displayName"] = displayName,
        ["description"] = description,
        ["originalName"] = file.FileName
    };
    File.WriteAllText(dest + ".meta.json", JsonSerializer.Serialize(meta));

    return Results.Ok(new { file = safeName, url = $"/diagramas/{safeName}" });
});

// One-time or manual endpoint to normalize all existing diagram HTML files in wwwroot/diagramas
app.MapPost("/api/diagramas/normalize-all", (IWebHostEnvironment env) =>
{
    var webRoot = env.WebRootPath ?? Path.Combine(Directory.GetCurrentDirectory(), "wwwroot");
    var dir = Path.Combine(webRoot, "diagramas");
    if (!Directory.Exists(dir)) return Results.Ok(new { updatedCount = 0, updatedFiles = Array.Empty<string>() });
    var updated = new List<string>();
    foreach (var f in Directory.GetFiles(dir, "*.html"))
    {
        try
        {
            if (NormalizeDiagramHtmlFile(f)) updated.Add(Path.GetFileName(f));
        }
        catch { }
    }

    return Results.Ok(new { updatedCount = updated.Count, updatedFiles = updated });
});

app.MapDelete("/api/diagramas/{name}", (string name, IWebHostEnvironment env) =>
{
    if (string.IsNullOrEmpty(name)) return Results.BadRequest();
    var webRoot = env.WebRootPath ?? Path.Combine(Directory.GetCurrentDirectory(), "wwwroot");
    var dir = Path.Combine(webRoot, "diagramas");
    var target = Path.Combine(dir, name);
    var meta = target + ".meta.json";
    if (!File.Exists(target)) return Results.NotFound();
    File.Delete(target);
    if (File.Exists(meta)) File.Delete(meta);
    return Results.Ok();
});

// Incidencias (boards + cards)
app.MapGet("/api/incidents/boards", (IncidentsService svc) => Results.Ok(svc.GetBoards()));
app.MapPost("/api/incidents/boards", async (HttpRequest req, IncidentsService svc) =>
{
    var form = await req.ReadFromJsonAsync<Dictionary<string,string>>();
    if (form == null || !form.TryGetValue("name", out var name) || string.IsNullOrWhiteSpace(name)) return Results.BadRequest();
    var b = svc.CreateBoard(name.Trim());
    return Results.Ok(b);
});
app.MapDelete("/api/incidents/boards/{id}", (long id, IncidentsService svc) => { svc.DeleteBoard(id); return Results.Ok(); });

app.MapGet("/api/incidents/cards", (long? boardId, IncidentsService svc) => Results.Ok(svc.GetCards(boardId)));
app.MapPost("/api/incidents/cards", async (HttpRequest req, IncidentsService svc) =>
{
    var dto = await req.ReadFromJsonAsync<Dictionary<string,string>>();
    if (dto == null) return Results.BadRequest();
    if (!dto.TryGetValue("boardId", out var sb) || !long.TryParse(sb, out var boardId)) return Results.BadRequest("boardId required");
    var title = dto.TryGetValue("title", out var t) ? t : "(sin titulo)";
    var desc = dto.TryGetValue("description", out var d) ? d : "";
    var card = svc.CreateCard(boardId, title, desc);
    return Results.Ok(card);
});
app.MapPut("/api/incidents/cards/{id}/move", (long id, long? boardId, IncidentsService svc) =>
{
    if (!boardId.HasValue) return Results.BadRequest("boardId required");
    svc.MoveCard(id, boardId.Value);
    return Results.Ok();
});
app.MapDelete("/api/incidents/cards/{id}", (long id, IncidentsService svc) => { svc.DeleteCard(id); return Results.Ok(); });

// Get resolved cards
app.MapGet("/api/incidents/cards/resolved", (long? boardId, IncidentsService svc) => Results.Ok(svc.GetResolvedCards(boardId)));

// Resolve / unresolve endpoints
app.MapPost("/api/incidents/cards/{id}/resolve", (long id, IncidentsService svc) => { svc.ResolveCard(id); return Results.Ok(); });
app.MapPost("/api/incidents/cards/{id}/unresolve", (long id, IncidentsService svc) => { svc.UnresolveCard(id); return Results.Ok(); });

// Notices endpoints
app.MapGet("/api/notices", (int? limit, NoticesService svc) => {
    var l = limit ?? 5;
    return Results.Ok(svc.GetLatest(l));
});

app.MapPost("/api/notices", async (HttpRequest req, NoticesService svc) => {
    var dto = await req.ReadFromJsonAsync<Notice>();
    if (dto == null || string.IsNullOrWhiteSpace(dto.Title)) return Results.BadRequest();
    var created = svc.Create(dto.Title.Trim(), dto.Body ?? "");
    return Results.Ok(created);
});

app.MapDelete("/api/notices/{id}", (long id, NoticesService svc) => { svc.Delete(id); return Results.Ok(); });
app.MapPut("/api/notices/{id}", async (long id, HttpRequest req, NoticesService svc) => {
    var dto = await req.ReadFromJsonAsync<Notice>();
    if (dto == null) return Results.BadRequest();
    svc.Update(id, dto.Title ?? string.Empty, dto.Body ?? string.Empty, dto.CreatedAt == default ? DateTime.UtcNow : dto.CreatedAt);
    var updated = svc.GetAll().FirstOrDefault(n => n.Id == id);
    return updated == null ? Results.NotFound() : Results.Ok(updated);
});

// Some hosting/proxies may block PUT; accept POST to the same route as a fallback for updates.
app.MapPost("/api/notices/{id}", async (long id, HttpRequest req, NoticesService svc) => {
    var dto = await req.ReadFromJsonAsync<Notice>();
    if (dto == null) return Results.BadRequest();
    svc.Update(id, dto.Title ?? string.Empty, dto.Body ?? string.Empty, dto.CreatedAt == default ? DateTime.UtcNow : dto.CreatedAt);
    var updated = svc.GetAll().FirstOrDefault(n => n.Id == id);
    return updated == null ? Results.NotFound() : Results.Ok(updated);
});

app.MapGet("/api/categories/root", (CategoriesService svc) => Results.Ok(svc.GetRoots()));
app.MapGet("/api/categories/{id}/children", (long id, CategoriesService svc) => Results.Ok(svc.GetChildren(id)));
app.MapPost("/api/categories", async (HttpRequest req, CategoriesService svc) =>
{
    var dto = await req.ReadFromJsonAsync<Category>();
    if (dto == null || string.IsNullOrWhiteSpace(dto.Name)) return Results.BadRequest();
    try
    {
        var created = svc.Create(dto.Name.Trim(), dto.ParentId);
        return Results.Ok(created);
    }
    catch (System.Data.SQLite.SQLiteException sex) when (sex.ErrorCode == (int)System.Data.SQLite.SQLiteErrorCode.Constraint)
    {
        return Results.Conflict(new { error = "Category name already exists (constraint violation)." });
    }
    catch (Exception ex)
    {
        return Results.Problem(detail: ex.Message);
    }
});
app.MapPut("/api/categories/{id}", async (long id, HttpRequest req, CategoriesService svc) =>
{
    var dto = await req.ReadFromJsonAsync<Category>();
    if (dto == null) return Results.BadRequest();
    try
    {
        svc.Update(id, dto.Name, dto.ParentId);
        return Results.Ok();
    }
    catch (System.Data.SQLite.SQLiteException sex) when (sex.ErrorCode == (int)System.Data.SQLite.SQLiteErrorCode.Constraint)
    {
        return Results.Conflict(new { error = "Category name already exists (constraint violation)." });
    }
    catch (Exception ex)
    {
        return Results.Problem(detail: ex.Message);
    }
});
app.MapDelete("/api/categories/{id}", (long id, CategoriesService svc) => { svc.Delete(id); return Results.Ok(); });

// Health check endpoint for IIS monitoring
app.MapGet("/api/health", () => Results.Ok(new { status = "healthy", timestamp = DateTime.UtcNow }));

// Removed MapRazorPages() - using only SPA architecture

app.Run();
