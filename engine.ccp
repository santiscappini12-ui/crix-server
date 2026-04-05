/*
 * CRIX ENGINE — Motor de Juegos C++ → WebAssembly
 *
 * COMPILAR:
 *   emcc src/engine.cpp -O2 -s WASM=1 \
 *        -s EXPORTED_RUNTIME_METHODS='["ccall","cwrap","UTF8ToString"]' \
 *        -s EXPORTED_FUNCTIONS='["_crix_init","_crix_frame","_crix_input","_crix_resize","_crix_add_part","_crix_remove_part","_crix_clear_parts","_crix_select_part","_crix_set_lighting","_crix_set_player_color","_crix_set_player_pos","_crix_set_mode","_crix_cam_scroll","_crix_get_player_state","_crix_is_ready"]' \
 *        -s USE_WEBGL2=1 -s FULL_ES3=1 -s ALLOW_MEMORY_GROWTH=1 \
 *        -s MODULARIZE=1 -s EXPORT_NAME="CrixEngine" \
 *        -o ../public/crix_engine.js
 */

#ifdef __EMSCRIPTEN__
  #include <emscripten.h>
  #include <emscripten/html5.h>
  #include <GLES3/gl3.h>
#else
  // Stubs para compilar sin Emscripten (pruebas locales)
  #define EMSCRIPTEN_KEEPALIVE
  typedef unsigned int GLuint;
  typedef unsigned int GLenum;
  typedef int GLint;
  typedef float GLfloat;
  void glGenVertexArrays(int,GLuint*){}
  void glGenBuffers(int,GLuint*){}
  void glBindVertexArray(GLuint){}
  void glBindBuffer(GLenum,GLuint){}
  void glBufferData(GLenum,int,const void*,GLenum){}
  void glEnableVertexAttribArray(GLuint){}
  void glVertexAttribPointer(GLuint,int,GLenum,bool,int,const void*){}
  GLuint glCreateShader(GLenum){return 0;}
  void glShaderSource(GLuint,int,const char**,const int*){}
  void glCompileShader(GLuint){}
  void glGetShaderiv(GLuint,GLenum,GLint*){}
  void glGetShaderInfoLog(GLuint,int,GLint*,char*){}
  GLuint glCreateProgram(){return 0;}
  void glAttachShader(GLuint,GLuint){}
  void glLinkProgram(GLuint){}
  void glUseProgram(GLuint){}
  GLint glGetUniformLocation(GLuint,const char*){return 0;}
  void glUniformMatrix4fv(GLint,int,bool,const float*){}
  void glUniform4f(GLint,float,float,float,float){}
  void glUniform3f(GLint,float,float,float){}
  void glUniform1f(GLint,float){}
  void glUniform1i(GLint,int){}
  void glEnable(GLenum){}
  void glDisable(GLenum){}
  void glCullFace(GLenum){}
  void glClearColor(float,float,float,float){}
  void glClear(GLuint){}
  void glViewport(int,int,int,int){}
  void glDrawElements(GLenum,int,GLenum,const void*){}
  void glLineWidth(float){}
  void glPolygonOffset(float,float){}
  void glBlendFunc(GLenum,GLenum){}
  #define GL_DEPTH_TEST 0
  #define GL_CULL_FACE 0
  #define GL_BACK 0
  #define GL_COLOR_BUFFER_BIT 0
  #define GL_DEPTH_BUFFER_BIT 0
  #define GL_ARRAY_BUFFER 0
  #define GL_ELEMENT_ARRAY_BUFFER 0
  #define GL_STATIC_DRAW 0
  #define GL_VERTEX_SHADER 0
  #define GL_FRAGMENT_SHADER 0
  #define GL_FLOAT 0
  #define GL_FALSE 0
  #define GL_TRIANGLES 0
  #define GL_LINES 0
  #define GL_UNSIGNED_INT 0
  #define GL_BLEND 0
  #define GL_SRC_ALPHA 0
  #define GL_ONE_MINUS_SRC_ALPHA 0
  #define GL_POLYGON_OFFSET_FILL 0
  #define GL_COMPILE_STATUS 0
#endif

#include <cmath>
#include <cstring>
#include <cstdio>
#include <cstdlib>
#include <vector>
#include <string>
#include <algorithm>

#ifndef M_PI
#define M_PI 3.14159265358979323846f
#endif

// ══════════════════════════════════════════════════════════════════
// TIPOS BASE
// ══════════════════════════════════════════════════════════════════
struct Vec3 {
  float x,y,z;
  Vec3(float x=0,float y=0,float z=0):x(x),y(y),z(z){}
  Vec3 operator+(const Vec3& o)const{return{x+o.x,y+o.y,z+o.z};}
  Vec3 operator-(const Vec3& o)const{return{x-o.x,y-o.y,z-o.z};}
  Vec3 operator*(float s)const{return{x*s,y*s,z*s};}
  Vec3& operator+=(const Vec3& o){x+=o.x;y+=o.y;z+=o.z;return*this;}
  float dot(const Vec3& o)const{return x*o.x+y*o.y+z*o.z;}
  Vec3 cross(const Vec3& o)const{return{y*o.z-z*o.y,z*o.x-x*o.z,x*o.y-y*o.x};}
  float len()const{return sqrtf(x*x+y*y+z*z);}
  Vec3 norm()const{float l=len();return l>0.0001f?Vec3(x/l,y/l,z/l):Vec3();}
};

struct Mat4 {
  float m[16];
  Mat4(){memset(m,0,sizeof(m));}
};

struct Color { float r,g,b,a=1.f; };

struct AABB {
  Vec3 min,max;
  bool intersects(const AABB& o)const{
    return min.x<o.max.x&&max.x>o.min.x&&
           min.y<o.max.y&&max.y>o.min.y&&
           min.z<o.max.z&&max.z>o.min.z;
  }
};

// ══════════════════════════════════════════════════════════════════
// MATEMÁTICA
// ══════════════════════════════════════════════════════════════════
Mat4 mat4_identity(){
  Mat4 m;
  m.m[0]=m.m[5]=m.m[10]=m.m[15]=1.f;
  return m;
}

Mat4 mat4_mul(const Mat4& a,const Mat4& b){
  Mat4 r;
  for(int i=0;i<4;i++)
    for(int j=0;j<4;j++)
      for(int k=0;k<4;k++)
        r.m[i*4+j]+=a.m[i*4+k]*b.m[k*4+j];
  return r;
}

Mat4 mat4_translate(Vec3 t){
  Mat4 m=mat4_identity();
  m.m[12]=t.x; m.m[13]=t.y; m.m[14]=t.z;
  return m;
}

Mat4 mat4_scale(Vec3 s){
  Mat4 m=mat4_identity();
  m.m[0]=s.x; m.m[5]=s.y; m.m[10]=s.z;
  return m;
}

Mat4 mat4_rotY(float a){
  Mat4 m=mat4_identity();
  m.m[0]=cosf(a);  m.m[2]=sinf(a);
  m.m[8]=-sinf(a); m.m[10]=cosf(a);
  return m;
}

Mat4 mat4_rotX(float a){
  Mat4 m=mat4_identity();
  m.m[5]=cosf(a); m.m[6]=-sinf(a);
  m.m[9]=sinf(a); m.m[10]=cosf(a);
  return m;
}

Mat4 mat4_perspective(float fov,float asp,float near,float far){
  Mat4 m;
  float f=1.f/tanf(fov*0.5f);
  m.m[0]=f/asp; m.m[5]=f;
  m.m[10]=(far+near)/(near-far);
  m.m[11]=-1.f;
  m.m[14]=(2.f*far*near)/(near-far);
  return m;
}

Mat4 mat4_lookat(Vec3 eye,Vec3 at,Vec3 up){
  Vec3 f=(at-eye).norm();
  Vec3 r=f.cross(up).norm();
  Vec3 u=r.cross(f);
  Mat4 m=mat4_identity();
  m.m[0]=r.x;   m.m[4]=r.y;   m.m[8]=r.z;
  m.m[1]=u.x;   m.m[5]=u.y;   m.m[9]=u.z;
  m.m[2]=-f.x;  m.m[6]=-f.y;  m.m[10]=-f.z;
  m.m[12]=-r.dot(eye);
  m.m[13]=-u.dot(eye);
  m.m[14]=f.dot(eye);
  return m;
}

// ══════════════════════════════════════════════════════════════════
// SHADERS
// ══════════════════════════════════════════════════════════════════
static const char* VS_PHONG = R"(#version 300 es
precision highp float;
layout(location=0) in vec3 aPos;
layout(location=1) in vec3 aNorm;
layout(location=2) in vec2 aUV;
uniform mat4 uMVP;
uniform mat4 uModel;
out vec3 vNorm;
out vec3 vWorldPos;
out vec2 vUV;
void main(){
  vec4 wp = uModel * vec4(aPos,1.0);
  vWorldPos = wp.xyz;
  vNorm = normalize(mat3(uModel)*aNorm);
  vUV = aUV;
  gl_Position = uMVP * vec4(aPos,1.0);
})";

static const char* FS_PHONG = R"(#version 300 es
precision highp float;
in vec3 vNorm;
in vec3 vWorldPos;
in vec2 vUV;
uniform vec4  uColor;
uniform vec3  uLightDir;
uniform vec3  uLightColor;
uniform vec3  uAmbient;
uniform float uRoughness;
uniform float uMetallic;
uniform vec3  uCamPos;
out vec4 FragColor;
void main(){
  vec3 N = normalize(vNorm);
  vec3 L = normalize(uLightDir);
  vec3 V = normalize(uCamPos - vWorldPos);
  vec3 H = normalize(L + V);
  float diff = max(dot(N,L), 0.0);
  float shininess = mix(4.0, 256.0, 1.0 - uRoughness);
  float spec = pow(max(dot(N,H), 0.0), shininess);
  vec3 baseCol = uColor.rgb;
  vec3 specCol = mix(vec3(0.04), baseCol, uMetallic);
  vec3 diffuse = diff * uLightColor * baseCol * (1.0 - uMetallic);
  vec3 specular = spec * uLightColor * specCol * (1.0 - uRoughness * 0.8);
  vec3 ambient = uAmbient * baseCol;
  FragColor = vec4(ambient + diffuse + specular, uColor.a);
})";

static const char* VS_SIMPLE = R"(#version 300 es
precision highp float;
layout(location=0) in vec3 aPos;
uniform mat4 uMVP;
void main(){ gl_Position = uMVP * vec4(aPos,1.0); })";

static const char* FS_SIMPLE = R"(#version 300 es
precision highp float;
uniform vec4 uColor;
out vec4 FragColor;
void main(){ FragColor = uColor; })";

// ══════════════════════════════════════════════════════════════════
// GEOMETRÍA
// ══════════════════════════════════════════════════════════════════
struct Vertex { float px,py,pz, nx,ny,nz, u,v; };
struct Mesh   { GLuint vao,vbo,ebo; int indexCount; bool valid=false; };

Mesh create_mesh(const std::vector<Vertex>& verts, const std::vector<uint32_t>& idx){
  Mesh m;
  glGenVertexArrays(1,&m.vao);
  glGenBuffers(1,&m.vbo);
  glGenBuffers(1,&m.ebo);
  glBindVertexArray(m.vao);
  glBindBuffer(GL_ARRAY_BUFFER,m.vbo);
  glBufferData(GL_ARRAY_BUFFER,(int)(verts.size()*sizeof(Vertex)),verts.data(),GL_STATIC_DRAW);
  glBindBuffer(GL_ELEMENT_ARRAY_BUFFER,m.ebo);
  glBufferData(GL_ELEMENT_ARRAY_BUFFER,(int)(idx.size()*sizeof(uint32_t)),idx.data(),GL_STATIC_DRAW);
  glEnableVertexAttribArray(0); glVertexAttribPointer(0,3,GL_FLOAT,GL_FALSE,sizeof(Vertex),(void*)0);
  glEnableVertexAttribArray(1); glVertexAttribPointer(1,3,GL_FLOAT,GL_FALSE,sizeof(Vertex),(void*)12);
  glEnableVertexAttribArray(2); glVertexAttribPointer(2,2,GL_FLOAT,GL_FALSE,sizeof(Vertex),(void*)24);
  glBindVertexArray(0);
  m.indexCount=(int)idx.size();
  m.valid=true;
  return m;
}

Mesh make_box(){
  // Cubo unitario centrado en origen (se escala vía uniforms)
  std::vector<Vertex> v;
  std::vector<uint32_t> idx;
  // 6 caras
  float faces[6][4][8]={
    // +Z
    {{-0.5f,-0.5f,0.5f,0,0,1,0,0},{0.5f,-0.5f,0.5f,0,0,1,1,0},{0.5f,0.5f,0.5f,0,0,1,1,1},{-0.5f,0.5f,0.5f,0,0,1,0,1}},
    // -Z
    {{0.5f,-0.5f,-0.5f,0,0,-1,0,0},{-0.5f,-0.5f,-0.5f,0,0,-1,1,0},{-0.5f,0.5f,-0.5f,0,0,-1,1,1},{0.5f,0.5f,-0.5f,0,0,-1,0,1}},
    // +X
    {{0.5f,-0.5f,0.5f,1,0,0,0,0},{0.5f,-0.5f,-0.5f,1,0,0,1,0},{0.5f,0.5f,-0.5f,1,0,0,1,1},{0.5f,0.5f,0.5f,1,0,0,0,1}},
    // -X
    {{-0.5f,-0.5f,-0.5f,-1,0,0,0,0},{-0.5f,-0.5f,0.5f,-1,0,0,1,0},{-0.5f,0.5f,0.5f,-1,0,0,1,1},{-0.5f,0.5f,-0.5f,-1,0,0,0,1}},
    // +Y
    {{-0.5f,0.5f,0.5f,0,1,0,0,0},{0.5f,0.5f,0.5f,0,1,0,1,0},{0.5f,0.5f,-0.5f,0,1,0,1,1},{-0.5f,0.5f,-0.5f,0,1,0,0,1}},
    // -Y
    {{-0.5f,-0.5f,-0.5f,0,-1,0,0,0},{0.5f,-0.5f,-0.5f,0,-1,0,1,0},{0.5f,-0.5f,0.5f,0,-1,0,1,1},{-0.5f,-0.5f,0.5f,0,-1,0,0,1}},
  };
  for(int f=0;f<6;f++){
    uint32_t b=(uint32_t)v.size();
    for(int i=0;i<4;i++) v.push_back({faces[f][i][0],faces[f][i][1],faces[f][i][2],faces[f][i][3],faces[f][i][4],faces[f][i][5],faces[f][i][6],faces[f][i][7]});
    idx.insert(idx.end(),{b,b+1,b+2,b,b+2,b+3});
  }
  return create_mesh(v,idx);
}

Mesh make_sphere(int segs=24){
  std::vector<Vertex> v; std::vector<uint32_t> idx;
  for(int i=0;i<=segs;i++){
    float phi=(float)M_PI*i/segs;
    for(int j=0;j<=segs;j++){
      float theta=2*(float)M_PI*j/segs;
      float x=sinf(phi)*cosf(theta),y=cosf(phi),z=sinf(phi)*sinf(theta);
      v.push_back({x*.5f,y*.5f,z*.5f,x,y,z,(float)j/segs,(float)i/segs});
    }
  }
  for(int i=0;i<segs;i++) for(int j=0;j<segs;j++){
    uint32_t a=i*(segs+1)+j,b=a+1,c=a+segs+1,d=c+1;
    idx.insert(idx.end(),{a,c,b,b,c,d});
  }
  return create_mesh(v,idx);
}

Mesh make_cylinder(int segs=20){
  std::vector<Vertex> v; std::vector<uint32_t> idx;
  for(int i=0;i<=segs;i++){
    float a=2*(float)M_PI*i/segs,x=cosf(a),z=sinf(a);
    v.push_back({x*.5f,-.5f,z*.5f,x,0,z,(float)i/segs,0});
    v.push_back({x*.5f, .5f,z*.5f,x,0,z,(float)i/segs,1});
  }
  for(int i=0;i<segs;i++){
    uint32_t b=i*2;
    idx.insert(idx.end(),{b,b+2,b+1,b+1,b+2,b+3});
  }
  return create_mesh(v,idx);
}

Mesh make_grid(int n=50,float size=2.f){
  std::vector<Vertex> verts; std::vector<uint32_t> idx;
  float h=size*n/2.f; uint32_t c=0;
  for(int i=-n;i<=n;i++){
    float f=i*size;
    verts.push_back({f,0,-h,0,1,0,0,0});
    verts.push_back({f,0, h,0,1,0,0,0});
    verts.push_back({-h,0,f,0,1,0,0,0});
    verts.push_back({ h,0,f,0,1,0,0,0});
    idx.push_back(c); idx.push_back(c+1);
    idx.push_back(c+2); idx.push_back(c+3);
    c+=4;
  }
  return create_mesh(verts,idx);
}

// ══════════════════════════════════════════════════════════════════
// SHADER HELPER
// ══════════════════════════════════════════════════════════════════
GLuint compile_prog(const char* vs,const char* fs){
  auto compile=[](GLenum t,const char* src)->GLuint{
    GLuint s=glCreateShader(t);
    glShaderSource(s,1,&src,nullptr);
    glCompileShader(s);
    GLint ok=0; glGetShaderiv(s,GL_COMPILE_STATUS,&ok);
    if(!ok){char buf[512];glGetShaderInfoLog(s,512,nullptr,buf);printf("[SHADER ERR] %s\n",buf);}
    return s;
  };
  GLuint p=glCreateProgram();
  glAttachShader(p,compile(GL_VERTEX_SHADER,vs));
  glAttachShader(p,compile(GL_FRAGMENT_SHADER,fs));
  glLinkProgram(p);
  return p;
}

// ══════════════════════════════════════════════════════════════════
// PARTE DEL MUNDO
// ══════════════════════════════════════════════════════════════════
enum PartType { PT_BLOCK=0,PT_SPHERE=1,PT_CYLINDER=2,PT_WEDGE=3,PT_SPAWN=4,PT_NPC=5 };

struct Part {
  int      id;
  PartType type;
  Vec3     pos, size, rot;
  Color    color;
  float    roughness=0.6f, metallic=0.f, transparent=0.f;
  bool     anchored=true, canCollide=true, castShadow=true;
  Vec3     velocity;
  AABB     aabb;
  void updateAABB(){
    aabb.min={pos.x-size.x*.5f, pos.y,           pos.z-size.z*.5f};
    aabb.max={pos.x+size.x*.5f, pos.y+size.y,     pos.z+size.z*.5f};
  }
};

// ══════════════════════════════════════════════════════════════════
// ESTADO GLOBAL
// ══════════════════════════════════════════════════════════════════
static struct {
  bool  ready = false;
  int   w=800, h=600;
  float time=0, dt=0;

  GLuint progPhong, progSimple;
  Mesh   boxMesh, sphereMesh, cylMesh, gridMesh;

  std::vector<Part> parts;

  // Jugador
  struct {
    Vec3  pos={0,4,0}, vel={0,0,0};
    float rotY=0, animT=0;
    bool  onGround=false, moving=false;
    Color color={0.36f,0.55f,0.94f,1.f};
  } player;

  // Cámara
  Vec3  camPos;
  float camTheta=0, camPhi=0.45f, camDist=16.f;

  // Input
  struct {
    bool  w=false,a=false,s=false,d=false,space=false,rmb=false;
    float joyX=0,joyY=0,mdx=0,mdy=0;
  } input;

  // Lighting
  Vec3  lightDir={0.4f,1.f,0.6f};
  Vec3  lightCol={1.f,0.98f,0.9f};
  Vec3  ambCol={0.22f,0.24f,0.30f};
  Color fogCol={0.53f,0.81f,0.92f,1.f};
  float fogDensity=0.007f;

  // Modo y Studio
  int   mode=0; // 0=GAME 1=STUDIO
  int   selPartId=-1;

  // Constantes física
  static constexpr float G_ACC = -28.f;
  static constexpr float JUMP  = 12.f;
  static constexpr float SPEED = 8.f;

} E;

// ══════════════════════════════════════════════════════════════════
// RENDER HELPERS
// ══════════════════════════════════════════════════════════════════
void use_phong(const Mat4& mvp,const Mat4& model,Color col,float rough,float metal){
  glUseProgram(E.progPhong);
  glUniformMatrix4fv(glGetUniformLocation(E.progPhong,"uMVP"),  1,GL_FALSE,mvp.m);
  glUniformMatrix4fv(glGetUniformLocation(E.progPhong,"uModel"),1,GL_FALSE,model.m);
  glUniform4f(glGetUniformLocation(E.progPhong,"uColor"),col.r,col.g,col.b,col.a);
  glUniform3f(glGetUniformLocation(E.progPhong,"uLightDir"),E.lightDir.x,E.lightDir.y,E.lightDir.z);
  glUniform3f(glGetUniformLocation(E.progPhong,"uLightColor"),E.lightCol.x,E.lightCol.y,E.lightCol.z);
  glUniform3f(glGetUniformLocation(E.progPhong,"uAmbient"),E.ambCol.x,E.ambCol.y,E.ambCol.z);
  glUniform3f(glGetUniformLocation(E.progPhong,"uCamPos"),E.camPos.x,E.camPos.y,E.camPos.z);
  glUniform1f(glGetUniformLocation(E.progPhong,"uRoughness"),rough);
  glUniform1f(glGetUniformLocation(E.progPhong,"uMetallic"),metal);
}

void draw_box_scaled(Vec3 pos,Vec3 size,float ry,Color col,float rough,float metal,
                     const Mat4& view,const Mat4& proj){
  Mat4 T=mat4_translate(Vec3(pos.x,pos.y+size.y*.5f,pos.z));
  Mat4 R=mat4_rotY(ry);
  Mat4 S=mat4_scale(size);
  Mat4 model=mat4_mul(T,R);
  Mat4 mvp=mat4_mul(proj,mat4_mul(view,mat4_mul(model,S)));
  use_phong(mvp,model,col,rough,metal);
  glBindVertexArray(E.boxMesh.vao);
  glDrawElements(GL_TRIANGLES,E.boxMesh.indexCount,GL_UNSIGNED_INT,0);
}

void draw_sphere_scaled(Vec3 pos,Vec3 size,Color col,float rough,float metal,
                        const Mat4& view,const Mat4& proj){
  Mat4 T=mat4_translate(Vec3(pos.x,pos.y+size.y*.5f,pos.z));
  Mat4 S=mat4_scale(size);
  Mat4 model=T;
  Mat4 mvp=mat4_mul(proj,mat4_mul(view,mat4_mul(model,S)));
  use_phong(mvp,model,col,rough,metal);
  glBindVertexArray(E.sphereMesh.vao);
  glDrawElements(GL_TRIANGLES,E.sphereMesh.indexCount,GL_UNSIGNED_INT,0);
}

void draw_cyl_scaled(Vec3 pos,Vec3 size,Color col,float rough,float metal,
                     const Mat4& view,const Mat4& proj){
  Mat4 T=mat4_translate(Vec3(pos.x,pos.y+size.y*.5f,pos.z));
  Mat4 S=mat4_scale(size);
  Mat4 model=T;
  Mat4 mvp=mat4_mul(proj,mat4_mul(view,mat4_mul(model,S)));
  use_phong(mvp,model,col,rough,metal);
  glBindVertexArray(E.cylMesh.vao);
  glDrawElements(GL_TRIANGLES,E.cylMesh.indexCount,GL_UNSIGNED_INT,0);
}

// ══════════════════════════════════════════════════════════════════
// RENDER AVATAR
// ══════════════════════════════════════════════════════════════════
void draw_avatar(Vec3 feetPos,float rotY,float animT,bool moving,bool onGround,
                 Color bodyCol,const Mat4& view,const Mat4& proj){
  float sw = (moving&&onGround) ? sinf(animT*9.f)*0.55f : 0.f;
  Color skin={1.f,0.86f,0.68f,1.f};
  Color eyeC={0.07f,0.07f,0.07f,1.f};

  auto drawPart=[&](Vec3 off,Vec3 sz,Color col,float rx=0.f){
    Mat4 base=mat4_translate(feetPos);
    Mat4 ry=mat4_rotY(rotY);
    Mat4 pivot=mat4_translate(off);
    Mat4 rx_m=mat4_rotX(rx);
    Mat4 S=mat4_scale(sz);
    Mat4 model=mat4_mul(base,mat4_mul(ry,mat4_mul(pivot,rx_m)));
    Mat4 mvp=mat4_mul(proj,mat4_mul(view,mat4_mul(model,S)));
    use_phong(mvp,model,col,0.8f,0.f);
    glBindVertexArray(E.boxMesh.vao);
    glDrawElements(GL_TRIANGLES,E.boxMesh.indexCount,GL_UNSIGNED_INT,0);
  };

  // Torso
  drawPart({0,1.70f,0},{1.0f,1.2f,0.55f},bodyCol);
  // Cabeza
  drawPart({0,2.75f,0},{0.72f,0.70f,0.70f},skin);
  // Ojos
  drawPart({-0.17f,2.78f,0.36f},{0.12f,0.12f,0.05f},eyeC);
  drawPart({ 0.17f,2.78f,0.36f},{0.12f,0.12f,0.05f},eyeC);
  // Brazos
  drawPart({-0.72f,1.70f,0},{0.40f,1.10f,0.40f},bodyCol, sw);
  drawPart({ 0.72f,1.70f,0},{0.40f,1.10f,0.40f},bodyCol,-sw);
  // Piernas
  drawPart({-0.27f,0.55f,0},{0.45f,1.10f,0.45f},bodyCol,-sw);
  drawPart({ 0.27f,0.55f,0},{0.45f,1.10f,0.45f},bodyCol, sw);
}

// ══════════════════════════════════════════════════════════════════
// FÍSICA
// ══════════════════════════════════════════════════════════════════
void step_physics(float dt){
  auto& p=E.player;
  const float AV_H=3.05f,AV_HW=0.5f,AV_HD=0.5f;

  // Movimiento input
  float mx=(E.input.d?1.f:0.f)-(E.input.a?1.f:0.f)+E.input.joyX;
  float mz=(E.input.s?1.f:0.f)-(E.input.w?1.f:0.f)+E.input.joyY;
  Vec3 dir=Vec3(mx,0,mz).norm();
  float ct=cosf(E.camTheta),st=sinf(E.camTheta);
  Vec3 wd={dir.x*ct+dir.z*st,0,-dir.x*st+dir.z*ct};
  p.moving=(wd.len()>0.05f);

  if(p.moving){
    p.vel.x=wd.x*E.SPEED; p.vel.z=wd.z*E.SPEED;
    float tRY=atan2f(wd.x,wd.z);
    float diff=tRY-p.rotY;
    while(diff<-(float)M_PI) diff+=2*(float)M_PI;
    while(diff> (float)M_PI) diff-=2*(float)M_PI;
    p.rotY+=diff*0.2f;
  } else { p.vel.x*=0.8f; p.vel.z*=0.8f; }

  p.vel.y+=E.G_ACC*dt;
  Vec3 prev=p.pos;
  p.pos.x+=p.vel.x*dt;
  p.pos.y+=p.vel.y*dt;
  p.pos.z+=p.vel.z*dt;

  p.onGround=false;
  for(auto& part:E.parts){
    if(!part.canCollide) continue;
    part.updateAABB();
    AABB pBox={{p.pos.x-AV_HW,p.pos.y,p.pos.z-AV_HD},{p.pos.x+AV_HW,p.pos.y+AV_H,p.pos.z+AV_HD}};
    if(!pBox.intersects(part.aabb)) continue;
    float oY=fminf(pBox.max.y,part.aabb.max.y)-fmaxf(pBox.min.y,part.aabb.min.y);
    float oX=fminf(pBox.max.x,part.aabb.max.x)-fmaxf(pBox.min.x,part.aabb.min.x);
    float oZ=fminf(pBox.max.z,part.aabb.max.z)-fmaxf(pBox.min.z,part.aabb.min.z);
    if(oY<=oX&&oY<=oZ){
      if(p.vel.y<=0&&p.pos.y<part.aabb.max.y&&p.pos.y+AV_H>part.aabb.max.y){
        p.pos.y=part.aabb.max.y; p.vel.y=0; p.onGround=true;
      } else if(p.vel.y>0&&p.pos.y+AV_H>part.aabb.min.y&&p.pos.y<part.aabb.min.y){
        p.pos.y=part.aabb.min.y-AV_H; p.vel.y=0;
      }
    } else { p.pos.x=prev.x; p.pos.z=prev.z; }
  }
  if(p.pos.y<-100.f){ p.pos={0,4,0}; p.vel={0,0,0}; }
  p.animT+=dt;
}

// ══════════════════════════════════════════════════════════════════
// API EXPORTADA
// ══════════════════════════════════════════════════════════════════
extern "C" {

EMSCRIPTEN_KEEPALIVE
void crix_init(int w,int h,int mode){
  E.w=w; E.h=h; E.mode=mode;
  E.progPhong  = compile_prog(VS_PHONG,FS_PHONG);
  E.progSimple = compile_prog(VS_SIMPLE,FS_SIMPLE);
  E.boxMesh    = make_box();
  E.sphereMesh = make_sphere(24);
  E.cylMesh    = make_cylinder(20);
  E.gridMesh   = make_grid(50,2.f);
  glEnable(GL_DEPTH_TEST);
  glEnable(GL_CULL_FACE);
  glCullFace(GL_BACK);
  glViewport(0,0,w,h);
  E.ready=true;
  printf("[CRIX] Motor listo — %dx%d modo=%d\n",w,h,mode);
}

EMSCRIPTEN_KEEPALIVE
void crix_resize(int w,int h){ E.w=w; E.h=h; glViewport(0,0,w,h); }

EMSCRIPTEN_KEEPALIVE
void crix_input(float jx,float jy,int w,int a,int s,int d,int space,int rmb,float mdx,float mdy){
  E.input.joyX=jx; E.input.joyY=jy;
  E.input.w=w; E.input.a=a; E.input.s=s; E.input.d=d;
  E.input.space=space; E.input.rmb=rmb;
  E.input.mdx=mdx; E.input.mdy=mdy;
  if(rmb){ E.camTheta+=mdx*0.01f; E.camPhi=fmaxf(0.05f,fminf(1.5f,E.camPhi+mdy*0.01f)); }
  if(space&&E.player.onGround){ E.player.vel.y=E.JUMP; E.player.onGround=false; }
}

EMSCRIPTEN_KEEPALIVE
void crix_cam_scroll(float delta){ E.camDist=fmaxf(3.f,fminf(100.f,E.camDist+delta)); }

EMSCRIPTEN_KEEPALIVE
void crix_frame(float dt){
  if(!E.ready) return;
  E.time+=dt; E.dt=dt;
  step_physics(dt);

  // Cámara
  auto& p=E.player.pos;
  float cy=p.y+1.5f;
  E.camPos={p.x+E.camDist*sinf(E.camTheta)*cosf(E.camPhi),cy+E.camDist*sinf(E.camPhi),p.z+E.camDist*cosf(E.camTheta)*cosf(E.camPhi)};

  Mat4 view=mat4_lookat(E.camPos,{p.x,cy,p.z},{0,1,0});
  Mat4 proj=mat4_perspective(1.22f,(float)E.w/E.h,0.1f,800.f);

  // Clear con color de cielo
  glClearColor(E.fogCol.r,E.fogCol.g,E.fogCol.b,1);
  glClear(GL_COLOR_BUFFER_BIT|GL_DEPTH_BUFFER_BIT);

  // Grid (solo en Studio)
  if(E.mode==1){
    glUseProgram(E.progSimple);
    Mat4 mvp=mat4_mul(proj,view);
    glUniformMatrix4fv(glGetUniformLocation(E.progSimple,"uMVP"),1,GL_FALSE,mvp.m);
    glUniform4f(glGetUniformLocation(E.progSimple,"uColor"),0.1f,0.13f,0.2f,1.f);
    glBindVertexArray(E.gridMesh.vao);
    glDrawElements(GL_LINES,E.gridMesh.indexCount,GL_UNSIGNED_INT,0);
  }

  // Partes del mundo
  for(auto& part:E.parts){
    if(part.transparent>0.99f) continue;
    Color col={part.color.r,part.color.g,part.color.b,1.f-part.transparent};
    if(col.a<0.99f){glEnable(GL_BLEND);glBlendFunc(GL_SRC_ALPHA,GL_ONE_MINUS_SRC_ALPHA);}
    if(part.type==PT_SPHERE) draw_sphere_scaled(part.pos,part.size,col,part.roughness,part.metallic,view,proj);
    else if(part.type==PT_CYLINDER) draw_cyl_scaled(part.pos,part.size,col,part.roughness,part.metallic,view,proj);
    else draw_box_scaled(part.pos,part.size,part.rot.y,col,part.roughness,part.metallic,view,proj);
    if(col.a<0.99f) glDisable(GL_BLEND);
    // Highlight selección en Studio
    if(E.mode==1 && E.selPartId==part.id){
      Color outline={0.35f,0.55f,1.f,0.5f};
      glEnable(GL_BLEND); glBlendFunc(GL_SRC_ALPHA,GL_ONE_MINUS_SRC_ALPHA);
      draw_box_scaled(part.pos,Vec3(part.size.x+0.05f,part.size.y+0.05f,part.size.z+0.05f),part.rot.y,outline,1.f,0.f,view,proj);
      glDisable(GL_BLEND);
    }
  }

  // Avatar jugador (solo en modo GAME)
  if(E.mode==0){
    draw_avatar(E.player.pos,E.player.rotY,E.player.animT,E.player.moving,E.player.onGround,E.player.color,view,proj);
  }
}

EMSCRIPTEN_KEEPALIVE
void crix_add_part(int id,int type,float px,float py,float pz,
                   float sx,float sy,float sz,float ry,
                   float cr,float cg,float cb,
                   float rough,float metal,float transp,
                   int anchored,int canCollide){
  Part p;
  p.id=id; p.type=(PartType)type;
  p.pos={px,py,pz}; p.size={sx,sy,sz}; p.rot={0,ry,0};
  p.color={cr,cg,cb,1.f};
  p.roughness=rough; p.metallic=metal; p.transparent=transp;
  p.anchored=anchored; p.canCollide=canCollide;
  p.vel={0,0,0}; p.updateAABB();
  for(auto& ep:E.parts) if(ep.id==id){ep=p;return;}
  E.parts.push_back(p);
}

EMSCRIPTEN_KEEPALIVE
void crix_remove_part(int id){
  E.parts.erase(std::remove_if(E.parts.begin(),E.parts.end(),[id](const Part& p){return p.id==id;}),E.parts.end());
}

EMSCRIPTEN_KEEPALIVE
void crix_clear_parts(){ E.parts.clear(); }

EMSCRIPTEN_KEEPALIVE
void crix_select_part(int id){ E.selPartId=id; }

EMSCRIPTEN_KEEPALIVE
void crix_set_lighting(float ar,float ag,float ab,float lr,float lg,float lb,
                       float ldx,float ldy,float ldz,float fr,float fg,float fb,float fd){
  E.ambCol={ar,ag,ab};
  E.lightCol={lr,lg,lb};
  E.lightDir=Vec3(ldx,ldy,ldz).norm();
  E.fogCol={fr,fg,fb,1.f};
  E.fogDensity=fd;
  // Actualizar cielo en el próximo frame
  glClearColor(fr,fg,fb,1.f);
}

EMSCRIPTEN_KEEPALIVE
void crix_set_player_color(float r,float g,float b){ E.player.color={r,g,b,1.f}; }

EMSCRIPTEN_KEEPALIVE
void crix_set_player_pos(float x,float y,float z){ E.player.pos={x,y,z}; E.player.vel={0,0,0}; }

EMSCRIPTEN_KEEPALIVE
void crix_set_mode(int mode){ E.mode=mode; }

EMSCRIPTEN_KEEPALIVE
const char* crix_get_player_state(){
  static char buf[256];
  snprintf(buf,sizeof(buf),
    "{\"x\":%.3f,\"y\":%.3f,\"z\":%.3f,\"ry\":%.3f,\"moving\":%d,\"onGround\":%d}",
    E.player.pos.x,E.player.pos.y,E.player.pos.z,
    E.player.rotY,E.player.moving?1:0,E.player.onGround?1:0);
  return buf;
}

EMSCRIPTEN_KEEPALIVE
int crix_is_ready(){ return E.ready?1:0; }

} // extern "C"
